import type { SaveStep, SavedFile, LoopContext } from '../../types';
import type { OrchestratorContext } from '../orchestrator-context';

export async function executeSaveStep(
  ctx: OrchestratorContext,
  step: SaveStep,
  context: LoopContext | undefined,
  index: number,
): Promise<void> {
  console.log(`[ORCHESTRATOR] Executing save: ${step.description}`);

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

export async function generateSavedFile(
  ctx: OrchestratorContext,
  saveDescription: string,
): Promise<SavedFile> {
  if (!ctx.openai) throw new Error('LLM client not initialized');

  const globalStateJson = JSON.stringify(ctx.globalState ?? [], null, 2);

  const response = await ctx.openai.chat.completions.create({
    model: ctx.resolveModels().save,
    messages: [
      {
        role: 'system',
        content:
          'You generate an output file for a completed workflow. ' +
          'The output should contain ONLY the data the user asked to save — no titles, summaries, or metadata about the workflow itself. ' +
          'Choose the best file format based on the data:\n' +
          '- "csv" for tabular/list data\n' +
          '- "excel" when the user asks for an Excel/spreadsheet file (return CSV content in "output" for conversion)\n' +
          '- "json" for structured data\n' +
          '- "txt" for plain text\n' +
          '- "md" for rich formatted text\n' +
          'Return a JSON object with "output" (the file contents) and "outputExtension" (one of: txt, csv, excel, md, json).',
      },
      {
        role: 'user',
        content:
          `Workflow: ${ctx.workflowName}\n\n` +
          `Save instruction: ${saveDescription}\n\n` +
          `Collected data JSON:\n${globalStateJson}\n\n` +
          'Generate the output file containing only the saved data in the most appropriate format. ' +
          'Do not include workflow metadata, summaries, or descriptions — just the data itself.',
      },
    ],
    response_format: { type: 'json_object' },
  });

  const rawContent = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(rawContent);
  const output = parsed?.output;
  const outputExtension = parsed?.outputExtension;

  console.log({ output, outputExtension });
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new Error('Invalid output response from LLM');
  }
  if (!['txt', 'csv', 'excel', 'md', 'json'].includes(outputExtension)) {
    throw new Error('Invalid output extension from LLM');
  }

  return { output: output.trim(), outputExtension };
}
