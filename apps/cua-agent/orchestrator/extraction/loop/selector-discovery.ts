import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Stagehand } from '../../../stagehand/v3';
import {
  buildStructuralDiscoveryScript,
  buildDomOutlineScript,
  buildSelectorCountScript,
  type CandidateSelector,
} from '../dom-scripts';
import { capturePageScreenshot } from '../common';

export interface SelectorDiscoveryResult {
  selector: string;
  itemDescription: string;
}

const selectorResponseSchema = z.object({
  selector: z.string().describe('A CSS selector that matches the repeating list/table items'),
  itemDescription: z.string().describe('Brief description of what each matched element represents'),
});

export async function discoverSelector(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
}): Promise<SelectorDiscoveryResult | null> {
  const { stagehand, llmClient, model, description } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

  // Phase 1: Structural auto-discovery (no LLM needed)
  // The script automatically searches main document + same-origin iframes
  let structuralCandidates = await page.evaluate<CandidateSelector[]>(
    buildStructuralDiscoveryScript(),
  );

  // Filter out bad candidates
  structuralCandidates = structuralCandidates.filter(
    (c) => !c.sampleTexts.every((s) => s.length === 0),
  );

  console.log(structuralCandidates);

  if (structuralCandidates.length > 0) {
    console.log(
      `[SELECTOR-DISCOVERY] Structural: found ${structuralCandidates.length} candidate(s)`,
    );
    for (const c of structuralCandidates) {
      console.log(
        `[SELECTOR-DISCOVERY]   "${c.selector}" count=${c.count} samples=${JSON.stringify(c.sampleTexts)}`,
      );
    }

    // If we have candidates, ask the LLM to pick the best one for the description
    const pickPrompt = `The user wants to iterate over: "${description}"

I found these repeating element patterns on the page:
${structuralCandidates.map((c, i) => `${i + 1}. selector: "${c.selector}" (${c.count} items)\n   Sample content: ${c.sampleTexts.map((t) => `"${t}"`).join(', ')}`).join('\n')}

A screenshot of the current page is attached. Use it to understand the visual layout and determine which selector best matches the items the user wants to iterate over. Consider what section of the page the items are in and which sample texts correspond to visible items.

Which selector best matches what the user is looking for? Return one of the selectors above exactly, or propose a refined version. If none match, return an empty selector.`;

    // Capture a screenshot to give the LLM visual context
    let screenshotDataUrl: string | null = null;
    try {
      screenshotDataUrl = await capturePageScreenshot(stagehand);
    } catch (e) {
      console.warn('[SELECTOR-DISCOVERY] Failed to capture screenshot:', (e as Error).message);
    }

    try {
      const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      if (screenshotDataUrl) {
        userContent.push({
          type: 'image_url',
          image_url: { url: screenshotDataUrl, detail: 'low' },
        });
      }
      userContent.push({ type: 'text', text: pickPrompt });

      const response = await llmClient.chat.completions.parse({
        model,
        messages: [{ role: 'user', content: userContent }],
        response_format: zodResponseFormat(selectorResponseSchema, 'selector_response'),
      });

      const parsed = response.choices[0]?.message?.parsed;
      if (parsed?.selector) {
        // Use iframe-aware count check
        const count = await page.evaluate<number>(buildSelectorCountScript(parsed.selector));
        console.log(`[SELECTOR-DISCOVERY] LLM picked: "${parsed.selector}" count=${count}`);
        if (count >= 2) {
          return parsed;
        }

        // LLM's pick didn't work — fall back to best structural candidate
        const best = structuralCandidates[0];
        if (best && best.count >= 2) {
          console.log(
            `[SELECTOR-DISCOVERY] Falling back to top structural candidate: "${best.selector}" count=${best.count}`,
          );
          return { selector: best.selector, itemDescription: best.sampleTexts[0] ?? '' };
        }
      }
    } catch (error) {
      console.warn('[SELECTOR-DISCOVERY] LLM pick failed:', (error as Error).message);

      // Fall back to best structural candidate
      const best = structuralCandidates[0];
      if (best && best.count >= 2) {
        return { selector: best.selector, itemDescription: best.sampleTexts[0] ?? '' };
      }
    }
  }

  // Phase 2: LLM-based discovery from DOM outline (fallback)
  console.log('[SELECTOR-DISCOVERY] No structural candidates, trying LLM outline analysis');

  const domOutline = await page.evaluate<string>(buildDomOutlineScript());
  if (!domOutline || domOutline.trim().length < 20) {
    console.warn('[SELECTOR-DISCOVERY] DOM outline too short, skipping');
    return null;
  }

  const truncatedOutline = domOutline.slice(0, 15_000);

  const prompt = `You are analyzing the DOM structure of a web page to find a CSS selector that matches repeating list/table items.

The user wants to iterate over: "${description}"

Here is a simplified DOM outline of the page:
\`\`\`
${truncatedOutline}
\`\`\`

Find a CSS selector that matches ALL the repeating items the user is looking for.
The selector should:
- Match the individual item containers (e.g. table rows, list items, card elements)
- Be specific enough to not match unrelated elements
- Use tag names, class names, roles, or structural patterns visible in the outline
- Prefer selectors like "table tbody tr", "ul.results > li", "[role=row]", ".card-item", etc.
- For links, try attribute selectors like a[href*="/some-path/"] if you see a common href pattern

Return the selector and a brief description of what each matched element represents.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'user', content: prompt },
    ];

    if (attempt === 1) {
      messages.push({
        role: 'assistant',
        content: `I'll try a different selector.`,
      });
      messages.push({
        role: 'user',
        content: `The previous selector didn't match enough elements (need at least 2). Please try a different, broader selector. Consider using attribute selectors like a[href*="/path/"], or look for common class names shared across multiple elements.`,
      });
    }

    try {
      const response = await llmClient.chat.completions.parse({
        model,
        messages,
        response_format: zodResponseFormat(selectorResponseSchema, 'selector_response'),
      });

      const parsed = response.choices[0]?.message?.parsed;
      if (!parsed || !parsed.selector) {
        console.warn('[SELECTOR-DISCOVERY] Empty LLM response');
        continue;
      }

      // Use iframe-aware count check
      const count = await page.evaluate<number>(buildSelectorCountScript(parsed.selector));

      console.log(
        `[SELECTOR-DISCOVERY] attempt=${attempt + 1} selector="${parsed.selector}" count=${count}`,
      );

      if (count >= 2) {
        return parsed;
      }

      console.warn(
        `[SELECTOR-DISCOVERY] Selector "${parsed.selector}" matched only ${count} element(s)`,
      );
    } catch (error) {
      console.warn(`[SELECTOR-DISCOVERY] attempt=${attempt + 1} failed:`, (error as Error).message);
    }
  }

  console.warn('[SELECTOR-DISCOVERY] Failed to find a valid selector after retries');
  return null;
}
