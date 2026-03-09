import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { LoopStep } from '../../../types';
import { ABSOLUTE_MAX_ITEMS, DEFAULT_MAX_ITEMS } from './constants';
import type { LoopDeps } from './deps';

const loopPlanSchema = z.object({
  query: z.string().trim().min(1),
  maxItems: z.number().int().positive().max(ABSOLUTE_MAX_ITEMS).nullable(),
});

export type LoopPlan = {
  query: string;
  maxItems: number;
};

function clampMaxItems(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ITEMS;
  const integer = Math.floor(Number(value));
  if (integer < 1) return 1;
  if (integer > ABSOLUTE_MAX_ITEMS) return ABSOLUTE_MAX_ITEMS;
  return integer;
}

function parseNumberFromDescription(description: string): number | undefined {
  const match = description.match(/\b(\d{1,4})\b/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function deriveLoopPlan(deps: LoopDeps, step: LoopStep): Promise<LoopPlan> {
  const fallbackMaxItems = clampMaxItems(parseNumberFromDescription(step.description));

  try {
    const response = await deps.openai.chat.completions.parse({
      model: deps.models.extract,
      messages: [
        {
          role: 'user',
          content:
            `You are preparing a web loop plan.\n\n` +
            `Loop description: "${step.description}"\n\n` +
            `Return JSON with:\n` +
            `- query: A concise search query describing exactly which page items to iterate over.\n` +
            `- maxItems: Integer max number of items to process. If no limit is specified, use ${fallbackMaxItems}.\n\n` +
            `Rules:\n` +
            `- Keep query specific and short.\n` +
            `- maxItems must be between 1 and ${ABSOLUTE_MAX_ITEMS}.`,
        },
      ],
      response_format: zodResponseFormat(loopPlanSchema, 'loop_plan_response'),
    });

    const parsed = response.choices[0]?.message?.parsed;
    if (!parsed) {
      return {
        query: step.description,
        maxItems: fallbackMaxItems,
      };
    }

    return {
      query: parsed.query,
      maxItems: clampMaxItems(parsed.maxItems ?? fallbackMaxItems),
    };
  } catch (error) {
    console.warn(
      '[LOOP] Failed to derive loop plan from description, using fallback:',
      (error as Error).message,
    );
    return {
      query: step.description,
      maxItems: fallbackMaxItems,
    };
  }
}
