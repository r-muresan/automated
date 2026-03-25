import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import type { Stagehand } from '../../../stagehand/v3';
import {
  buildElementExtractionScript,
  buildElementFromPointScript,
  buildDomOutlineScript,
  type ElementFromPointResult,
} from '../dom-scripts';
import { capturePageScreenshot } from '../common';
import type { ExtractedElement } from './shared';
import { coordinateExtractionSchema } from './shared';
import { handleDirectExtraction } from './extract-direct';
import {
  isMoonshotModel,
  normalizeMoonshotCoordinates,
} from '../../../stagehand/v3/agent/utils/coordinateNormalization';

interface EvaluatablePage {
  evaluate<T>(script: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
}

export interface SelectorExtractionResult {
  data: unknown;
  chosenSelector: string | null;
  targetItemCount: number | null;
}

const SCROLL_SETTLE_MS = 800;

interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  percentScrolled: number;
  remainingBelow: number;
}

const SCROLL_POSITION_SCRIPT = `(() => {
  const el = document.scrollingElement || document.documentElement;
  const scrollTop = Math.round(el.scrollTop);
  const scrollHeight = Math.round(el.scrollHeight);
  const viewportHeight = Math.round(window.innerHeight);
  const maxScroll = Math.max(scrollHeight - viewportHeight, 1);
  return {
    scrollTop,
    scrollHeight,
    viewportHeight,
    percentScrolled: Math.round((scrollTop / maxScroll) * 100),
    remainingBelow: Math.max(scrollHeight - scrollTop - viewportHeight, 0),
  };
})()`;

function formatScrollPosition(pos: ScrollPosition): string {
  return `[Scroll position: ${pos.percentScrolled}% | viewport ${pos.viewportHeight}px | page height ${pos.scrollHeight}px | ${pos.remainingBelow}px remaining below]`;
}

const MAX_DOM_OUTLINE_CHARS = 8000;

const DOT_COLORS: [number, number, number][] = [
  [255, 0, 0], // red
  [0, 200, 0], // green
  [0, 100, 255], // blue
  [255, 0, 255], // magenta
  [255, 170, 0], // orange
  [0, 220, 220], // cyan
  [255, 100, 0], // dark orange
  [150, 50, 255], // purple
];

const DOT_RADIUS = 10;
const BORDER_WIDTH = 2;

function createDotSvg(
  x: number,
  y: number,
  color: [number, number, number],
  label: string,
): string {
  const [r, g, b] = color;
  return `<circle cx="${x}" cy="${y}" r="${DOT_RADIUS}" fill="rgb(${r},${g},${b})" stroke="white" stroke-width="${BORDER_WIDTH}" />
<text x="${x + DOT_RADIUS + 4}" y="${y + 4}" font-family="sans-serif" font-size="13" font-weight="bold" fill="rgb(${r},${g},${b})" stroke="white" stroke-width="3" paint-order="stroke">${label}</text>`;
}

/**
 * Saves a debug PNG showing the screenshot with colored dots at each coordinate.
 */
async function saveDebugCoordinateImage(
  screenshotDataUrl: string,
  coordinates: { x: number; y: number }[],
  label: string,
): Promise<void> {
  // Decode the base64 data URL to a buffer
  const base64Match = screenshotDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
  if (!base64Match) return;
  const imgBuffer = Buffer.from(base64Match[1], 'base64');

  const metadata = await sharp(imgBuffer).metadata();
  const width = metadata.width ?? 1280;
  const height = metadata.height ?? 720;

  // Build SVG overlay with dots
  const dots = coordinates
    .map((c, i) => {
      const color = DOT_COLORS[i % DOT_COLORS.length];
      return createDotSvg(c.x, c.y, color, `(${c.x},${c.y})`);
    })
    .join('\n');

  const svgOverlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${dots}</svg>`,
  );

  const tmpDir = path.join(os.tmpdir(), 'cua-debug-coordinates');
  await fs.mkdir(tmpDir, { recursive: true });
  const filename = `coords-${label}-${Date.now()}.png`;
  const filepath = path.join(tmpDir, filename);

  await sharp(imgBuffer)
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .png()
    .toFile(filepath);

  console.log(`[DEBUG] Coordinate overlay saved: ${filepath}`);
}

/**
 * Coordinate-based DOM extraction: first decides strategy (coordinate vs direct),
 * then if coordinate, runs a tool-using agent (kimi k2.5) to scroll and find elements.
 */
export async function extractWithCoordinates(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  agentModel: string;
  dataExtractionGoal: string;
  screenshotDataUrl: string;
}): Promise<SelectorExtractionResult | null> {
  const { stagehand, llmClient, model, agentModel, dataExtractionGoal, screenshotDataUrl } = params;

  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

  // Step 1: Strategy decision (extract model)
  const prompt = `You are extracting data from a web page. Look at this screenshot.

Extraction goal: ${dataExtractionGoal}

Choose a strategy:
1. **coordinate** (STRONGLY preferred): If the page contains repeating elements (lists, tables, cards, rows, etc.) that match the extraction goal, choose this. We will automatically find the elements.
2. **direct**: Return the extracted data directly from what you see in the screenshot. Use this ONLY when the data is NOT in repeating elements (e.g., a single value, scattered data across unrelated parts of the page).

When using "coordinate", leave "data" as null.
When using "direct", set the "data" field with the extracted information.

Additionally, if the extraction goal mentions a specific number of items to collect (e.g. "first 6 stocks", "top 10 results", "3 cheapest flights"), set "targetItemCount" to that number. If no specific count is mentioned, set it to null.`;

  const strategyResponse = await llmClient.chat.completions.parse({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'high' } },
        ],
      },
    ],
    response_format: zodResponseFormat(coordinateExtractionSchema, 'coordinate_extraction'),
  });

  const parsed = strategyResponse.choices[0]?.message?.parsed;
  if (!parsed) return null;

  console.log('[EXTRACTION] Strategy decision:', parsed.strategy);

  if (parsed.strategy === 'direct') {
    return {
      data: handleDirectExtraction(parsed),
      chosenSelector: null,
      targetItemCount: parsed.targetItemCount ?? null,
    };
  }

  // Step 2: Run coordinate-finding agent (agent model — kimi k2.5)
  const coordinates = await runCoordinateAgent({
    stagehand,
    llmClient,
    agentModel,
    dataExtractionGoal,
    screenshotDataUrl,
  });

  if (!coordinates || coordinates.length === 0) {
    console.warn('[EXTRACTION] Coordinate agent returned no coordinates');
    return null;
  }

  // Step 3: For each coordinate, find the element and derive a selector
  // Compute the actual scale factor from screenshot dimensions vs CSS viewport
  // (screenshot may be at DPR scale, e.g. 2x on Retina, or 1x on headless)
  const viewport = await page.evaluate<{ width: number; height: number }>(`(() => {
    return {
      width: window.innerWidth || document.documentElement.clientWidth || 1280,
      height: window.innerHeight || document.documentElement.clientHeight || 720,
    };
  })()`);

  let screenshotScale = 1;
  try {
    const base64Match = screenshotDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
    if (base64Match) {
      const imgBuffer = Buffer.from(base64Match[1], 'base64');
      const metadata = await sharp(imgBuffer).metadata();
      if (metadata.width && viewport.width) {
        screenshotScale = metadata.width / viewport.width;
        console.log(
          `[EXTRACTION] Screenshot scale: ${screenshotScale.toFixed(2)}x (screenshot ${metadata.width}x${metadata.height}, viewport ${viewport.width}x${viewport.height})`,
        );
      }
    }
  } catch (e) {
    console.warn('[EXTRACTION] Could not determine screenshot scale, assuming 1x');
  }

  // Collect unique selectors from all coordinates
  const selectorMap = new Map<string, number>(); // selector → matchCount

  for (const coord of coordinates) {
    // Scroll to the position where this coordinate was captured
    await page.evaluate(`(() => {
      const el = document.scrollingElement || document.documentElement;
      el.scrollTop = ${coord.scrollTop};
    })()`);
    // Brief settle for scroll
    await new Promise((r) => setTimeout(r, 100));

    // Convert from screenshot pixel space to CSS pixel space
    const cssX = Math.round(coord.x / screenshotScale);
    const cssY = Math.round(coord.y / screenshotScale);
    console.log(
      `[EXTRACTION] Trying coordinate (${coord.x}, ${coord.y}) at scrollTop=${coord.scrollTop} → CSS (${cssX}, ${cssY})`,
    );

    const result = await page.evaluate<ElementFromPointResult | null>(
      buildElementFromPointScript(cssX, cssY),
    );

    if (!result) {
      console.warn(`[EXTRACTION] No element found at (${coord.x}, ${coord.y})`);
      continue;
    }

    console.log(
      `[EXTRACTION] Coordinate (${coord.x}, ${coord.y}) → selector "${result.selector}" (${result.matchCount} matches)`,
    );

    // Track unique selectors — keep the highest match count if duplicate
    const existing = selectorMap.get(result.selector);
    if (!existing || result.matchCount > existing) {
      selectorMap.set(result.selector, result.matchCount);
    }
  }

  if (selectorMap.size === 0) {
    console.warn('[EXTRACTION] Could not derive a selector from any coordinate');
    return null;
  }

  // Extract elements from ALL unique selectors and combine
  const allElements: ExtractedElement[] = [];
  const allSelectors: string[] = [];

  for (const [selector, matchCount] of selectorMap) {
    console.log(`[EXTRACTION] Extracting with selector "${selector}" (${matchCount} matches)`);

    const elements = await page.evaluate<ExtractedElement[]>(
      buildElementExtractionScript(selector),
    );

    if (elements.length === 0) {
      console.warn(`[EXTRACTION] Derived selector "${selector}" matched 0 elements`);
      continue;
    }

    console.log(`[EXTRACTION] Selector "${selector}" extracted ${elements.length} element(s)`);
    allElements.push(...elements);
    allSelectors.push(selector);
  }

  if (allElements.length === 0) {
    console.warn('[EXTRACTION] No elements extracted from any selector');
    return null;
  }

  const combinedSelector = allSelectors.join(', ');
  console.log(
    `[EXTRACTION] Combined ${allSelectors.length} selector(s), ${allElements.length} total element(s)`,
  );

  console.log(allElements);

  const data = await structureElements({
    elements: allElements,
    chosenSelector: combinedSelector,
    llmClient,
    model,
    dataExtractionGoal,
  });

  return {
    data,
    chosenSelector: combinedSelector,
    targetItemCount: parsed.targetItemCount ?? null,
  };
}

// ── Coordinate-finding agent ──────────────────────────────────────────────

const COORDINATE_AGENT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'scroll_down',
      description: 'Scroll the page down to see more content below.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_up',
      description: 'Scroll the page up to see content above.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Take a fresh screenshot of the current page viewport.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_coordinates',
      description:
        'Select the (x, y) coordinates of example elements visible on the current screen. Call this for EVERY group of repeating elements you can see. You can call this multiple times as you scroll — coordinates accumulate. ONE example per group is enough.',
      parameters: {
        type: 'object',
        properties: {
          coordinates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate of the example element' },
                y: { type: 'number', description: 'Y coordinate of the example element' },
              },
              required: ['x', 'y'],
            },
            description:
              'Array of coordinates, one per group visible on screen. Each points to ONE example of a repeating element.',
          },
        },
        required: ['coordinates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description:
        'Call this when you have finished selecting coordinates for ALL groups of elements on the page. You should scroll through the entire page first to find all groups before calling done.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const MAX_AGENT_STEPS = 5;

async function runCoordinateAgent(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  agentModel: string;
  dataExtractionGoal: string;
  screenshotDataUrl: string;
}): Promise<{ x: number; y: number; scrollTop: number }[] | null> {
  const { stagehand, llmClient, agentModel, dataExtractionGoal, screenshotDataUrl } = params;

  // Track latest screenshot for debug overlay
  let latestScreenshot = screenshotDataUrl;
  let selectCallCount = 0;
  // Track current scroll position so we can record it with each coordinate
  let currentScrollTop = 0;

  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

  // Get viewport for coordinate normalization (kimi uses 0-1 scale)
  const viewport = await page.evaluate<{ width: number; height: number }>(`(() => {
    const visual = window.visualViewport;
    return {
      width: Math.round(visual?.width ?? window.innerWidth ?? document.documentElement?.clientWidth ?? 1280),
      height: Math.round(visual?.height ?? window.innerHeight ?? document.documentElement?.clientHeight ?? 720),
    };
  })()`);

  const usesUnitScale = isMoonshotModel(agentModel);
  const coordNote = usesUnitScale
    ? 'Coordinates should be in 0-1 range (normalized to viewport width/height).'
    : 'Coordinates should be in pixel values.';

  // Capture compressed DOM outline and scroll position for context
  const [domOutline, scrollPos] = await Promise.all([
    page.evaluate<string>(buildDomOutlineScript()),
    page.evaluate<ScrollPosition>(SCROLL_POSITION_SCRIPT),
  ]);

  console.log({
    domOutlineLength: domOutline.length,
  });

  fs.writeFile('dom-outline.txt', domOutline);

  const truncatedOutline =
    domOutline.length > MAX_DOM_OUTLINE_CHARS
      ? domOutline.slice(0, MAX_DOM_OUTLINE_CHARS) + '\n... (truncated)'
      : domOutline;

  console.log(
    `[EXTRACTION] Coordinate agent context: DOM outline ${domOutline.length} chars (truncated to ${truncatedOutline.length}), scroll ${scrollPos.percentScrolled}%, page height ${scrollPos.scrollHeight}px`,
  );

  // Accumulate all coordinates across multiple select_coordinates calls
  const allCoordinates: { x: number; y: number; scrollTop: number }[] = [];
  currentScrollTop = scrollPos.scrollTop;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a visual element finder. Your job is to look at a web page screenshot and identify ALL groups of repeating elements that match the extraction goal.

IMPORTANT: A page may have MULTIPLE distinct groups of elements (e.g. "Top Stories" cards, "Opinion" cards, "Related News" cards). You must find ALL of them, not just the first group you see.

You are given a compressed DOM outline of the page. Use it to:
- Understand the full page structure and where repeating elements are likely located
- Know how far you need to scroll (check the scroll position metadata)
- Decide when to stop — if scroll position shows you're near the bottom and the DOM outline shows no more relevant sections below, call done

Workflow:
1. Look at the current screenshot and call select_coordinates for all groups of elements visible
2. Check the scroll position — if there's significant content below, scroll down
3. If you find more groups, call select_coordinates again for the new ones
4. Keep scrolling until you've seen the entire page OR the scroll position shows you're at/near the bottom
5. Call done when you've covered all groups

For each group, you only need ONE example coordinate — we will automatically find all similar elements in that group. ${coordNote}`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Find ALL groups of repeating elements matching this goal: "${dataExtractionGoal}"

${formatScrollPosition(scrollPos)}

Compressed DOM outline of the page:
\`\`\`
${truncatedOutline}
\`\`\`

Here is the current page screenshot. Select coordinates for all visible groups, then scroll to find more.`,
        },
        { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'high' } },
      ],
    },
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const response = await llmClient.chat.completions.create({
      model: agentModel,
      messages,
      tools: COORDINATE_AGENT_TOOLS,
      tool_choice: 'auto',
      max_tokens: 1024,
    });

    const assistantMessage = response.choices[0]?.message;
    if (!assistantMessage) break;

    // Add assistant response to history
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls;

    console.log(toolCalls);

    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls — agent is done
      break;
    }

    let doneSignaled = false;

    // Process tool calls
    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function') continue;
      const name = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch (e) {
        console.warn(
          `[EXTRACTION] Malformed JSON from coordinate agent tool "${name}": ${toolCall.function.arguments}`,
        );
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content:
            'Error: your tool call had invalid JSON arguments. Please try again with valid JSON.',
        });
        continue;
      }

      if (name === 'done') {
        console.log(
          `[EXTRACTION] Coordinate agent done. Total coordinates: ${allCoordinates.length}`,
        );
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: 'Done.',
        });
        doneSignaled = true;
        continue;
      }

      if (name === 'select_coordinates') {
        const rawCoords = args.coordinates as { x: number; y: number }[];
        if (!rawCoords || rawCoords.length === 0) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'No coordinates provided. Please try again.',
          });
          continue;
        }

        // Normalize coordinates if using unit-scale model
        const normalizedCoords = rawCoords.map((c) => {
          if (usesUnitScale && c.x <= 1 && c.y <= 1) {
            const norm = normalizeMoonshotCoordinates(c.x, c.y, viewport);
            return { ...norm, scrollTop: currentScrollTop };
          }
          return { x: Math.round(c.x), y: Math.round(c.y), scrollTop: currentScrollTop };
        });

        allCoordinates.push(...normalizedCoords);
        selectCallCount++;

        // Debug: save screenshot with dots overlay
        saveDebugCoordinateImage(
          latestScreenshot,
          normalizedCoords,
          `select-${selectCallCount}`,
        ).catch(() => {});

        console.log(
          `[EXTRACTION] Coordinate agent added ${normalizedCoords.length} coordinate(s) (total: ${allCoordinates.length}):`,
          normalizedCoords,
        );
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Recorded ${normalizedCoords.length} coordinate(s). Total so far: ${allCoordinates.length}. Continue scrolling to find more groups, or call done if you've covered the entire page.`,
        });
        continue;
      }

      if (name === 'scroll_down') {
        const scrollResult = await page.evaluate<{ scrolled: boolean }>(`(() => {
          const el = document.scrollingElement || document.documentElement;
          const before = el.scrollTop;
          el.scrollBy(0, window.innerHeight * 0.8);
          return { scrolled: el.scrollTop > before };
        })()`);
        await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));

        const [newScreenshot, newScrollPos] = await Promise.all([
          capturePageScreenshot(stagehand),
          page.evaluate<ScrollPosition>(SCROLL_POSITION_SCRIPT),
        ]);
        latestScreenshot = newScreenshot;
        currentScrollTop = newScrollPos.scrollTop;
        const scrollInfo = formatScrollPosition(newScrollPos);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: [
            {
              type: 'text',
              text: scrollResult.scrolled
                ? `Scrolled down. ${scrollInfo}\nSelect coordinates for any new groups you see.`
                : `Already at the bottom of the page. ${scrollInfo}\nCall done if you have selected all groups.`,
            },
            { type: 'image_url', image_url: { url: newScreenshot, detail: 'high' } },
          ] as any,
        });
        continue;
      }

      if (name === 'scroll_up') {
        const scrollResult = await page.evaluate<{ scrolled: boolean }>(`(() => {
          const el = document.scrollingElement || document.documentElement;
          const before = el.scrollTop;
          el.scrollBy(0, -window.innerHeight * 0.8);
          return { scrolled: el.scrollTop < before };
        })()`);
        await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));

        const [newScreenshot, newScrollPos] = await Promise.all([
          capturePageScreenshot(stagehand),
          page.evaluate<ScrollPosition>(SCROLL_POSITION_SCRIPT),
        ]);
        latestScreenshot = newScreenshot;
        currentScrollTop = newScrollPos.scrollTop;
        const scrollInfo = formatScrollPosition(newScrollPos);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: [
            {
              type: 'text',
              text: scrollResult.scrolled
                ? `Scrolled up. ${scrollInfo}`
                : `Already at the top of the page. ${scrollInfo}`,
            },
            { type: 'image_url', image_url: { url: newScreenshot, detail: 'high' } },
          ] as any,
        });
        continue;
      }

      if (name === 'screenshot') {
        const newScreenshot = await capturePageScreenshot(stagehand);
        latestScreenshot = newScreenshot;
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: [
            { type: 'text', text: 'Here is the current screenshot.' },
            { type: 'image_url', image_url: { url: newScreenshot, detail: 'high' } },
          ] as any,
        });
        continue;
      }

      // Unknown tool
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `Unknown tool: ${name}`,
      });
    }

    if (doneSignaled) break;
  }

  if (allCoordinates.length > 0) {
    console.log(
      `[EXTRACTION] Coordinate agent finished with ${allCoordinates.length} total coordinate(s)`,
    );
    return allCoordinates;
  }

  console.warn('[EXTRACTION] Coordinate agent finished with no coordinates');
  return null;
}

// ── Known selector extraction (pagination) ─────────────────────────────────

/**
 * Extract data using a known selector (skips LLM strategy decision).
 * Used for pagination pages where the selector was already discovered.
 */
export async function extractWithKnownSelector(params: {
  page: EvaluatablePage;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
  selector: string;
}): Promise<unknown | null> {
  const { page, llmClient, model, dataExtractionGoal, selector } = params;

  const elements = await page.evaluate<ExtractedElement[]>(buildElementExtractionScript(selector));

  if (elements.length === 0) {
    console.warn(`[EXTRACTION] Known selector "${selector}" matched 0 elements`);
    return null;
  }

  console.log(`[EXTRACTION] Known selector "${selector}" matched ${elements.length} element(s)`);

  return structureElements({
    elements,
    chosenSelector: selector,
    llmClient,
    model,
    dataExtractionGoal,
  });
}

// ── Element structuring (cleanup) ──────────────────────────────────────────

/**
 * Executes a JS parser function string against the elements array.
 * The function receives the full elements array and must return an array of items.
 */
function executeParserFunction(parserCode: string, elements: ExtractedElement[]): unknown[] {
  // The model returns a function body that takes `elements` and returns an array
  const parserFn = new Function('elements', parserCode) as (els: ExtractedElement[]) => unknown[];
  const result = parserFn(elements);
  if (!Array.isArray(result)) {
    console.warn('[EXTRACTION] Parser function did not return an array, wrapping result');
    return [result];
  }
  return result;
}

/**
 * Structures raw extracted DOM elements into clean data using an LLM.
 * Single element → simple text extraction.
 * Multiple elements → the LLM can return either:
 *   1. Direct items (JSON array) — for simple extractions
 *   2. A JavaScript parser function — for complex/pattern-based extractions
 */
export async function structureElements(params: {
  elements: ExtractedElement[];
  chosenSelector: string;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
}): Promise<unknown | null> {
  const { elements, chosenSelector, llmClient, model, dataExtractionGoal } = params;

  // Single element: return simple structure
  if (elements.length === 1) {
    return { extraction: elements[0].innerText || elements[0].textContent };
  }

  const responseSchema = z.object({
    mode: z.enum(['items', 'parser']),
    items: z.array(z.record(z.string(), z.unknown())).nullable(),
    parserFunction: z.string().nullable(),
  });

  const BATCH_SIZE = 80;
  const firstBatch = elements.slice(0, BATCH_SIZE);
  const elementsSummary = firstBatch
    .map((el, j) => `El ${j + 1}: ${el.innerText || el.textContent} (${el.href})`)
    .join('\n');

  const mappingPrompt = `Extract structured data from these DOM elements.

Extraction goal: ${dataExtractionGoal}

Elements found via selector "${chosenSelector}":
###
${elementsSummary}
###

Total elements: ${elements.length} (showing first ${firstBatch.length})

You have two options for extracting data:

**Option 1 - Direct items** (mode: "items"): Return the extracted items directly as a JSON array. Best for simple extractions where the data maps cleanly to fields.

**Option 2 - Parser function** (mode: "parser"): Return a JavaScript function body that will parse ALL elements. Best when the data requires complex text splitting, regex, or pattern matching that would be lossy in a direct extraction.

IMPORTANT: Each element is a PLAIN JavaScript object (NOT a DOM node). You CANNOT use DOM methods like querySelector, getElementsByClassName, children, closest, etc. The available fields on each element are:
- el.innerText: string (the visible text, may contain newlines)
- el.textContent: string (all text content)
- el.tagName: string (e.g. "DIV", "A")
- el.id: string
- el.href: string (the link URL, if any)
- el.outerHTML: string (the raw HTML of the element - use regex or string methods to parse this if you need sub-element data)

The function receives an \`elements\` argument (array of these plain objects) and must return an array of item objects.

Example parser function body:
\`\`\`
return elements.map(el => {
  const lines = (el.innerText || '').split('\\n').filter(Boolean);
  // To extract data from nested HTML, use regex on outerHTML:
  const priceMatch = el.outerHTML.match(/class="price"[^>]*>([^<]+)/);
  return { name: lines[0] || '', price: priceMatch ? priceMatch[1].trim() : '', url: el.href || '' };
}).filter(item => item.name);
\`\`\`

Choose the approach that will produce the most accurate extraction. Remove any elements that are not relevant to the extraction goal.

Return JSON with:
- "mode": either "items" or "parser"
- "items": (if mode is "items") array of extracted item objects with appropriate field names
- "parserFunction": (if mode is "parser") the function body string`;

  const mappingResponse = await llmClient.chat.completions.parse({
    model,
    messages: [{ role: 'user', content: mappingPrompt }],
    response_format: zodResponseFormat(responseSchema, 'extracted_data'),
  });

  const parsed = mappingResponse.choices[0]?.message?.parsed;
  if (!parsed) return null;

  if (parsed.mode === 'parser' && parsed.parserFunction) {
    console.log('[EXTRACTION] Using parser function mode');

    console.log(parsed.parserFunction);

    try {
      const allItems = executeParserFunction(parsed.parserFunction, elements);
      console.log(`[EXTRACTION] Parser function produced ${allItems.length} item(s)`);
      return { items: allItems };
    } catch (err) {
      console.error('[EXTRACTION] Parser function failed, falling back to direct mode:', err);
      // Fall through to direct items if parser fails
    }
  }

  // Direct items mode, or parser fallback — process in batches
  if (parsed.mode === 'items' && parsed.items?.length) {
    // First batch already done, process remaining batches
    const allItems: unknown[] = [...parsed.items];

    const directSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });

    for (let i = BATCH_SIZE; i < elements.length; i += BATCH_SIZE) {
      const batch = elements.slice(i, i + BATCH_SIZE);
      const batchSummary = batch
        .map((el, j) => `El ${i + j + 1}: ${el.innerText || el.textContent} (${el.href})`)
        .join('\n');

      const batchPrompt = `Extract structured data from these DOM elements.

Extraction goal: ${dataExtractionGoal}

Elements found via selector "${chosenSelector}":
###
${batchSummary}
###

Return a JSON object with an "items" array, where each entry is one extracted item. Use the same field names as before.
Remove any elements that are not relevant to the extraction goal.`;

      const batchResponse = await llmClient.chat.completions.parse({
        model,
        messages: [{ role: 'user', content: batchPrompt }],
        response_format: zodResponseFormat(directSchema, 'extracted_data'),
      });

      const batchParsed = batchResponse.choices[0]?.message?.parsed;
      if (batchParsed?.items) {
        allItems.push(...batchParsed.items);
      }
    }

    return { items: allItems };
  }

  return null;
}
