import type { SaveStep, SavedFile, LoopContext } from '../../types';
import type { OrchestratorContext } from '../orchestrator-context';

const MAX_STATE_CHARS = 1_000;

/**
 * Truncate the globalState JSON to fit within the LLM context budget.
 * Keeps the structure `[{ source, items }]` but trims item arrays from the end.
 */
function truncateGlobalStateJson(globalState: any[]): string {
  const full = JSON.stringify(globalState ?? [], null, 2);
  if (full.length <= MAX_STATE_CHARS) return full;

  // Clone and progressively trim items from the last entry backwards
  const clone: any[] = JSON.parse(JSON.stringify(globalState));
  for (let i = clone.length - 1; i >= 0; i--) {
    const entry = clone[i];
    if (!entry?.items?.length) continue;
    while (entry.items.length > 0) {
      entry.items.pop();
      const attempt = JSON.stringify(clone, null, 2);
      if (attempt.length <= MAX_STATE_CHARS) {
        entry.items.push({ _truncated: `remaining items omitted to fit context` });
        return JSON.stringify(clone, null, 2);
      }
    }
    // Entire entry's items emptied, remove the entry
    clone.splice(i, 1);
  }

  return JSON.stringify([{ _truncated: 'data too large, all entries omitted' }], null, 2);
}

export async function executeSaveStep(
  ctx: OrchestratorContext,
  step: SaveStep,
  context: LoopContext | undefined,
  index: number,
): Promise<void> {
  console.log(`[ORCHESTRATOR] Executing save: ${step.description}`);

  console.dir(ctx.globalState, { depth: 5 });

  try {
    const savedFile = await generateSavedFile(ctx, step.description);
    ctx.savedFiles.push(savedFile);
    console.log(
      `[ORCHESTRATOR] Save step produced ${savedFile.outputExtension} file (${ctx.savedFiles.length} total)`,
    );

    ctx.stepResults.push({
      instruction: step.description,
      success: true,
      output: JSON.stringify({
        outputExtension: savedFile.outputExtension,
        savedFileIndex: ctx.savedFiles.length - 1,
      }),
    });
    ctx.emit({
      type: 'step:end',
      step,
      index,
      success: true,
      savedFile: {
        output: savedFile.output,
        outputExtension: savedFile.outputExtension,
        savedFileIndex: ctx.savedFiles.length - 1,
      },
    });
  } catch (error: any) {
    console.error(`[ORCHESTRATOR] Save step failed:`, error.message ?? error);

    // Fallback: save raw globalState as JSON
    const fallback: SavedFile = {
      output: JSON.stringify(ctx.globalState ?? [], null, 2),
      outputExtension: 'json',
    };
    ctx.savedFiles.push(fallback);

    ctx.stepResults.push({
      instruction: step.description,
      success: true,
      output: JSON.stringify({
        outputExtension: 'json',
        savedFileIndex: ctx.savedFiles.length - 1,
        fallback: true,
      }),
    });
    ctx.emit({
      type: 'step:end',
      step,
      index,
      success: true,
      savedFile: {
        output: fallback.output,
        outputExtension: 'json',
        savedFileIndex: ctx.savedFiles.length - 1,
        fallback: true,
      },
    });
  }
}

function buildSaveMessages(
  workflowName: string,
  saveDescription: string,
  globalStateJson: string,
  code: boolean,
): Array<{ role: 'system' | 'user'; content: string }> {
  let systemPrompt =
    'You generate an output file for a completed workflow. ' +
    'The output should contain ONLY the data the user asked to save — no titles, summaries, or metadata about the workflow itself. ' +
    'Choose the best file format based on the data:\n' +
    '- "csv" for tabular/list data\n' +
    '- "excel" when the user asks for an Excel/spreadsheet file (return CSV content in "output" for conversion)\n' +
    '- "json" for structured data\n' +
    '- "txt" for plain text\n' +
    '- "md" for rich formatted text\n\n';

  if (code) {
    systemPrompt +=
      'Return a JSON object with "outputExtension" (one of: txt, csv, excel, md, json) and EITHER:\n' +
      '- "output": the file contents as a string, OR\n' +
      '- "code": a JavaScript function body that receives `data` (the full globalState array) and returns the file content string. ' +
      'The code will be executed as `new Function("data", code)`. Do NOT use `import`, `require`, or `export`. Just write the function body.\n\n' +
      'Use "output" for small/simple results. Use "code" when the data is large and you need to transform it programmatically.\n\n' +
      'The `data` parameter is an array of objects, each with `source` (string) and `items` (array of objects).\n' +
      'Example: `data[0].items` gives you the items array from the first source.';
  } else {
    systemPrompt +=
      'Return a JSON object with "output" (the file contents as a string) and "outputExtension" (one of: txt, csv, excel, md, json).';
  }

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        `Workflow: ${workflowName}\n\n` +
        `Save instruction: ${saveDescription}\n\n` +
        `Collected data (may be truncated for context):\n${globalStateJson}\n\n` +
        'Generate the output file containing only the saved data in the most appropriate format. ' +
        'Do not include workflow metadata, summaries, or descriptions — just the data itself.',
    },
  ];
}

export async function generateSavedFile(
  ctx: OrchestratorContext,
  saveDescription: string,
): Promise<SavedFile> {
  if (!ctx.openai) throw new Error('LLM client not initialized');

  const globalStateJson = truncateGlobalStateJson(ctx.globalState);

  // First attempt: allow code or output
  const response = await ctx.openai.chat.completions.create({
    model: ctx.resolveModels().save,
    messages: buildSaveMessages(ctx.workflowName, saveDescription, globalStateJson, true),
    response_format: { type: 'json_object' },
  });

  const rawContent = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(rawContent);
  const outputExtension = parsed?.outputExtension;

  if (!['txt', 'csv', 'excel', 'md', 'json'].includes(outputExtension)) {
    throw new Error('Invalid output extension from LLM');
  }

  let output: string | undefined;

  if (typeof parsed?.output === 'string' && parsed.output.trim().length > 0) {
    console.log({ output: parsed.output, outputExtension });
    output = parsed.output;
  } else if (typeof parsed?.code === 'string' && parsed.code.trim().length > 0) {
    console.log({ code: parsed.code, outputExtension });
    try {
      const transformFn = new Function('data', parsed.code);
      const result = transformFn(ctx.globalState ?? []);
      if (typeof result === 'string' && result.trim().length > 0) {
        output = result;
      } else {
        console.warn(
          '[SAVE] Code returned non-string or empty result, falling back to direct output',
        );
      }
    } catch (codeError: any) {
      console.warn(
        `[SAVE] Code execution failed: ${codeError.message}, falling back to direct output`,
      );
    }
  }

  // Fallback: ask the LLM to return output directly (no code option)
  if (!output) {
    console.log('[SAVE] Using direct-output fallback LLM call');
    const fallbackResponse = await ctx.openai.chat.completions.create({
      model: ctx.resolveModels().save,
      messages: buildSaveMessages(ctx.workflowName, saveDescription, globalStateJson, false),
      response_format: { type: 'json_object' },
    });

    const fallbackRaw = fallbackResponse.choices[0]?.message?.content ?? '{}';
    const fallbackParsed = JSON.parse(fallbackRaw);
    output = fallbackParsed?.output;

    if (typeof output !== 'string' || output.trim().length === 0) {
      throw new Error('Fallback LLM call also failed to produce valid output');
    }
  }

  return { output: output.trim(), outputExtension };
}
