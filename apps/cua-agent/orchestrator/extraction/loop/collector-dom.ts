import { createHash } from 'crypto';
import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { discoverSelector } from './selector-discovery';
import { scrollPageDown, tryClickPaginationButton } from './page-scroll';
import type { CollectedItem, ItemCollector } from './types';

const MAX_SCROLL_ATTEMPTS = 3;

interface DomElementData {
  textContent: string;
  innerText: string;
  tagName: string;
  id: string;
  className: string;
  href: string;
  dataset: Record<string, string>;
  outerHTMLTruncated: string;
}

function buildExtractionScript(selector: string): string {
  const selectorJson = JSON.stringify(selector);
  return `
    (() => {
      const MAX_HTML = 500;
      const MAX_TEXT = 300;
      const els = document.querySelectorAll(${selectorJson});
      return Array.from(els).map(el => ({
        textContent: (el.textContent || '').trim().slice(0, MAX_TEXT),
        innerText: (el.innerText || '').trim().slice(0, MAX_TEXT),
        tagName: el.tagName?.toLowerCase() || '',
        id: el.id || '',
        className: (typeof el.className === 'string' ? el.className : ''),
        href: el.href || el.querySelector('a')?.href || '',
        dataset: Object.assign({}, el.dataset),
        outerHTMLTruncated: el.outerHTML.slice(0, MAX_HTML),
      }));
    })()
  `;
}

function fingerprint(selector: string, outerHTML: string): string {
  const hash = createHash('sha256')
    .update(selector + ':' + outerHTML)
    .digest('hex')
    .slice(0, 24);
  return `dom:${hash}`;
}

export function createDomSelectorCollector(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
}): ItemCollector {
  const { stagehand, llmClient, model, description } = params;

  let selector: string | null = null;
  let discoveryDone = false;
  let exhausted = false;
  const knownFingerprints = new Set<string>();

  async function queryNewItems(): Promise<CollectedItem[]> {
    if (!selector) return [];
    const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
    const elements = await page.evaluate<DomElementData[]>(buildExtractionScript(selector));

    const items: CollectedItem[] = [];
    for (const el of elements) {
      const fp = fingerprint(selector, el.outerHTMLTruncated);
      if (knownFingerprints.has(fp)) continue;
      knownFingerprints.add(fp);

      const data: Record<string, unknown> = {
        text: el.innerText || el.textContent,
        tagName: el.tagName,
      };
      if (el.id) data.id = el.id;
      if (el.className) data.className = el.className;
      if (el.href) data.href = el.href;
      if (Object.keys(el.dataset).length > 0) data.dataset = el.dataset;

      items.push({ fingerprint: fp, data });
    }
    return items;
  }

  return {
    name: 'dom-selector',
    async collect(pageIndex: number): Promise<CollectedItem[]> {
      if (exhausted) return [];

      // Discover selector on first call
      if (!discoveryDone) {
        discoveryDone = true;
        const result = await discoverSelector({ stagehand, llmClient, model, description });
        if (!result) return [];
        selector = result.selector;
        console.log(
          `[LOOP-COLLECT] DOM: using selector "${selector}" (${result.itemDescription})`,
        );
      }

      // First page: just query what's visible
      if (pageIndex === 0) {
        const items = await queryNewItems();
        console.log(`[LOOP-COLLECT] DOM page 0: ${items.length} items`);
        return items;
      }

      // Subsequent pages: scroll to reveal more items
      const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

      for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
        const scrolled = await scrollPageDown(page);
        if (!scrolled) break;

        const items = await queryNewItems();
        if (items.length > 0) {
          console.log(
            `[LOOP-COLLECT] DOM page ${pageIndex}: ${items.length} items after scroll ${i + 1}`,
          );
          return items;
        }
      }

      // Scroll exhausted — try pagination button via accessibility tree
      const clicked = await tryClickPaginationButton(stagehand);
      if (clicked) {
        const items = await queryNewItems();
        if (items.length > 0) {
          console.log(
            `[LOOP-COLLECT] DOM page ${pageIndex}: ${items.length} items after pagination click`,
          );
          return items;
        }
      }

      exhausted = true;
      console.log(`[LOOP-COLLECT] DOM page ${pageIndex}: exhausted`);
      return [];
    },
  };
}
