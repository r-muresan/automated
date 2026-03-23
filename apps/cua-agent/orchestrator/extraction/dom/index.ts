import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import {
  buildStructuralDiscoveryScript,
  buildDomOutlineScript,
  type CandidateSelector,
} from '../dom-scripts';
import { extractWithSelector } from './extract-selector';

/**
 * DOM extraction: gathers the DOM outline and structural candidates,
 * then delegates to selector-based or direct extraction.
 * Returns null if this approach fails.
 */
export async function extractDom(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
}): Promise<unknown | null> {
  const { stagehand, llmClient, model, dataExtractionGoal } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

  const [structuralCandidates, domOutline] = await Promise.all([
    page.evaluate<CandidateSelector[]>(buildStructuralDiscoveryScript()),
    page.evaluate<string>(buildDomOutlineScript()),
  ]);

  console.log(structuralCandidates);

  if (!domOutline || domOutline.trim().length < 20) {
    console.warn('[EXTRACTION] DOM outline too short for selector strategy');
    return null;
  }

  if (domOutline.length > 30_000) {
    console.warn('[EXTRACTION] Truncating DOM');
  }

  const truncatedOutline = domOutline.slice(0, 30_000);

  let candidatesSection = '';
  if (structuralCandidates.length > 0) {
    candidatesSection =
      '\nRepeating element patterns found on page:\n' +
      structuralCandidates
        .map(
          (c, i) =>
            `${i + 1}. "${c.selector}" (${c.count} items) — samples: ${c.sampleTexts.map((t) => `"${t}"`).join(', ')}`,
        )
        .join('\n') +
      '\n';
  }

  return extractWithSelector({
    page,
    llmClient,
    model,
    dataExtractionGoal,
    truncatedOutline,
    candidatesSection,
  });
}
