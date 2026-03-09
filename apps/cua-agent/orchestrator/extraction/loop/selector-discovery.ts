import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Stagehand } from '../../../stagehand/v3';

export interface SelectorDiscoveryResult {
  selector: string;
  itemDescription: string;
}

const selectorResponseSchema = z.object({
  selector: z.string().describe('A CSS selector that matches the repeating list/table items'),
  itemDescription: z
    .string()
    .describe('Brief description of what each matched element represents'),
});

interface CandidateSelector {
  selector: string;
  count: number;
  sampleTexts: string[];
}

/**
 * Structural auto-discovery: walks the DOM looking for parents with many
 * similar children. Works on Framer/React sites where classes are hashed
 * and the outline is too noisy for an LLM to parse.
 */
function buildStructuralDiscoveryScript(): string {
  return `
    (() => {
      const MIN_REPEATING = 3;
      const candidates = [];

      const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'link', 'meta', 'br', 'hr', 'img']);

      function getSignature(el) {
        const tag = el.tagName?.toLowerCase() || '';
        if (SKIP_TAGS.has(tag)) return '__skip__';
        const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).sort().join(' ');
        const role = el.getAttribute('role') || '';
        const hasHref = el.hasAttribute('href') ? 'href' : '';
        return [tag, cls, role, hasHref].filter(Boolean).join('|');
      }

      function buildSelector(el) {
        const tag = el.tagName?.toLowerCase() || '';
        const cls = typeof el.className === 'string' ? el.className.trim() : '';
        if (cls) {
          const first = cls.split(/\\s+/)[0];
          return tag + '.' + first;
        }
        const role = el.getAttribute('role');
        if (role) return tag + '[role="' + role + '"]';
        return tag;
      }

      function getSampleText(el) {
        return (el.innerText || el.textContent || '').trim().split('\\n')[0].slice(0, 80);
      }

      // Walk all elements looking for parents with many same-signature children
      const allElements = document.querySelectorAll('*');
      const checked = new Set();

      for (const el of allElements) {
        const parent = el.parentElement;
        if (!parent || checked.has(parent)) continue;
        checked.add(parent);

        const children = Array.from(parent.children);
        if (children.length < MIN_REPEATING) continue;

        // Group children by structural signature
        const groups = {};
        for (const child of children) {
          const sig = getSignature(child);
          if (!groups[sig]) groups[sig] = [];
          groups[sig].push(child);
        }

        for (const [sig, members] of Object.entries(groups)) {
          if (sig === '__skip__' || members.length < MIN_REPEATING) continue;

          // Build a selector for this group
          const representative = members[0];
          const childSel = buildSelector(representative);

          // Try to build a more specific selector using parent context
          let parentSel = '';
          if (parent.id) {
            parentSel = '#' + parent.id;
          } else {
            const pCls = typeof parent.className === 'string' ? parent.className.trim() : '';
            if (pCls) {
              parentSel = parent.tagName.toLowerCase() + '.' + pCls.split(/\\s+/)[0];
            }
          }

          const fullSelector = parentSel ? parentSel + ' > ' + childSel : childSel;

          // Verify the selector actually matches the expected count
          let count;
          try {
            count = document.querySelectorAll(fullSelector).length;
          } catch { continue; }

          if (count < MIN_REPEATING) continue;

          // Score: prefer more matches, prefer elements with links/text
          const hasLinks = members.some(m => m.querySelector('a[href]'));
          const hasText = members.some(m => (m.innerText || '').trim().length > 10);

          candidates.push({
            selector: fullSelector,
            count,
            score: count * (hasLinks ? 3 : 1) * (hasText ? 2 : 1),
            sampleTexts: members.slice(0, 3).map(m => getSampleText(m)),
          });
        }

        // Also check if children share a common link pattern (e.g. a[href*="/portfolio/"])
        const childLinks = children.map(c => {
          const a = c.tagName === 'A' ? c : c.querySelector('a[href]');
          return a ? a.getAttribute('href') : null;
        }).filter(Boolean);

        if (childLinks.length >= MIN_REPEATING) {
          // Find common href prefix
          const sorted = childLinks.sort();
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          let prefix = '';
          for (let i = 0; i < Math.min(first.length, last.length); i++) {
            if (first[i] === last[i]) prefix += first[i];
            else break;
          }
          if (prefix.length > 1 && prefix.includes('/')) {
            const hrefSelector = 'a[href^="' + prefix + '"]';
            let count;
            try { count = document.querySelectorAll(hrefSelector).length; } catch { continue; }
            if (count >= MIN_REPEATING) {
              const samples = children.slice(0, 3).map(c => getSampleText(c));
              candidates.push({
                selector: hrefSelector,
                count,
                score: count * 5,
                sampleTexts: samples,
              });
            }
          }
        }
      }

      // Deduplicate by selector, keeping highest-scored entry
      const seen = {};
      for (const c of candidates) {
        if (!seen[c.selector] || seen[c.selector].score < c.score) {
          seen[c.selector] = c;
        }
      }
      const deduped = Object.values(seen);

      // Sort by score descending, return top 5
      deduped.sort((a, b) => b.score - a.score);
      return deduped.slice(0, 5).map(c => ({
        selector: c.selector,
        count: c.count,
        sampleTexts: c.sampleTexts,
      }));
    })()
  `;
}

function buildDomOutlineScript(): string {
  return `
    (() => {
      const MAX_DEPTH = 6;
      const MAX_CHILDREN = 30;
      const MAX_TEXT = 60;

      function outline(el, depth) {
        if (depth > MAX_DEPTH) return '';
        const tag = el.tagName?.toLowerCase();
        if (!tag) return '';
        if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return '';

        const id = el.id ? '#' + el.id : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.')
          : '';
        const role = el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '';

        const rawHref = el.getAttribute('href') || '';
        const href = rawHref ? '[href="' + rawHref.slice(0, 60) + '"]' : '';

        let text = '';
        if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
          const t = el.childNodes[0].textContent?.trim() ?? '';
          if (t.length > 0) text = ' "' + t.slice(0, MAX_TEXT) + (t.length > MAX_TEXT ? '...' : '') + '"';
        }

        const indent = '  '.repeat(depth);
        let result = indent + '<' + tag + id + cls + role + href + '>' + text + '\\n';

        const children = Array.from(el.children).slice(0, MAX_CHILDREN);
        for (const child of children) {
          result += outline(child, depth + 1);
        }
        if (el.children.length > MAX_CHILDREN) {
          result += indent + '  <!-- +' + (el.children.length - MAX_CHILDREN) + ' more -->\\n';
        }
        return result;
      }

      return outline(document.body, 0);
    })()
  `;
}

export async function discoverSelector(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
}): Promise<SelectorDiscoveryResult | null> {
  const { stagehand, llmClient, model, description } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

  // Phase 1: Structural auto-discovery (no LLM needed)
  const structuralCandidates = await page.evaluate<CandidateSelector[]>(
    buildStructuralDiscoveryScript(),
  );

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

Which selector best matches what the user is looking for? You may return one of the selectors above exactly, or propose a refined version. If none match, return an empty selector.`;

    try {
      const response = await llmClient.chat.completions.parse({
        model,
        messages: [{ role: 'user', content: pickPrompt }],
        response_format: zodResponseFormat(selectorResponseSchema, 'selector_response'),
      });

      const parsed = response.choices[0]?.message?.parsed;
      if (parsed?.selector) {
        const count = await page.evaluate<number>(
          `document.querySelectorAll(${JSON.stringify(parsed.selector)}).length`,
        );
        console.log(
          `[SELECTOR-DISCOVERY] LLM picked: "${parsed.selector}" count=${count}`,
        );
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
      console.warn(
        '[SELECTOR-DISCOVERY] LLM pick failed:',
        (error as Error).message,
      );

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

      const count = await page.evaluate<number>(
        `document.querySelectorAll(${JSON.stringify(parsed.selector)}).length`,
      );

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
      console.warn(
        `[SELECTOR-DISCOVERY] attempt=${attempt + 1} failed:`,
        (error as Error).message,
      );
    }
  }

  console.warn('[SELECTOR-DISCOVERY] Failed to find a valid selector after retries');
  return null;
}
