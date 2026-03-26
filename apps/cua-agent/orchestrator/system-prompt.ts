/**
 * Builds the system prompt for the browser automation agent.
 */
import type { LoopContext } from '../types';

export function buildSystemPrompt(
  context?: LoopContext,
): string {
  const sections: string[] = [];

  sections.push(
    `You are a helpful assistant that can use a web browser. Do not ask follow up questions, the user will trust your judgement to complete the task.`,
  );

  if (context && context.item != null) {
    sections.push('');
    sections.push(
      `Current Item being processed: ${JSON.stringify(context.item)}. Use this information to help you complete the task.`,
    );
    sections.push('');
  }

  console.log(sections.join('\n'));

  return sections.join('\n');
}
