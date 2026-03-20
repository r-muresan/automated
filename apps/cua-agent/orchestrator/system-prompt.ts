/**
 * Builds the system prompt for the browser automation agent.
 */
import { buildSessionDownloadedFilesSection } from './session-files';
import type { DownloadedSessionFile, LoopContext } from '../types';
import { getSpreadsheetProvider } from './agent-tools/spreadsheet/detection';
import type { SpreadsheetProvider } from './agent-tools/types';

function buildSpreadsheetInstructions(provider: SpreadsheetProvider): string {
  const toolPrefix = provider === 'google_sheets' ? 'spreadsheet' : 'excel';
  const appName = provider === 'google_sheets' ? 'Google Sheets' : 'Excel';
  return [
    `You are currently on a ${appName} spreadsheet. Use the spreadsheet tools over manual browser interactions for reading, writing, and navigating cells:`,
    `- Use \`${toolPrefix}_read_cell\` or \`${toolPrefix}_read_sheet\` to read data instead of trying to visually parse the spreadsheet.`,
    `- Use \`${toolPrefix}_write_cells\` to write data instead of clicking on cells and typing.`,
    `- Use \`${toolPrefix}_select_cell\` to navigate to a specific cell.`,
  ].join('\n');
}

const MAX_GLOBAL_STATE_CHARS = 10_000;
const MAX_ENTRY_VALUE_CHARS = 200;

/**
 * Truncate individual values in global state entries that are very long,
 * then truncate the overall JSON if still too large.
 */
function truncateGlobalStateForPrompt(globalState: any[]): string {
  if (!globalState || globalState.length === 0) return '';

  // Deep clone and truncate individual values
  const clone: any[] = JSON.parse(JSON.stringify(globalState));
  for (const entry of clone) {
    if (!entry?.items?.length) continue;
    for (const item of entry.items) {
      if (!item || typeof item !== 'object') continue;
      for (const [key, value] of Object.entries(item)) {
        if (typeof value === 'string' && value.length > MAX_ENTRY_VALUE_CHARS) {
          (item as Record<string, string>)[key] =
            value.slice(0, MAX_ENTRY_VALUE_CHARS) + '… (truncated)';
        }
      }
    }
  }

  const json = JSON.stringify(clone, null, 2);
  if (json.length <= MAX_GLOBAL_STATE_CHARS) return json;

  // Progressively trim items from the last entry backwards
  for (let i = clone.length - 1; i >= 0; i--) {
    const entry = clone[i];
    if (!entry?.items?.length) continue;
    while (entry.items.length > 0) {
      entry.items.pop();
      const attempt = JSON.stringify(clone, null, 2);
      if (attempt.length <= MAX_GLOBAL_STATE_CHARS) {
        entry.items.push({ _truncated: 'remaining items omitted to fit context' });
        return JSON.stringify(clone, null, 2);
      }
    }
    clone.splice(i, 1);
  }

  return JSON.stringify([{ _truncated: 'data too large, all entries omitted' }], null, 2);
}

export function buildSystemPrompt(
  globalState: any[],
  downloadedFiles: DownloadedSessionFile[],
  context?: LoopContext,
  currentUrl?: string,
): string {
  const sections: string[] = [];

  sections.push(
    `You are a helpful assistant that can use a web browser. Do not ask the user for help, the user will trust your judgement.`,
  );
  sections.push(
    `If you hit a login, 2FA, CAPTCHA, passkey, or any credential gate that requires the user's secrets, call the tool "request_user_credentials" with a concise reason and wait.`,
  );

  if (currentUrl) {
    const provider = getSpreadsheetProvider(currentUrl);
    if (provider) {
      sections.push('');
      sections.push(buildSpreadsheetInstructions(provider));
    }
  }

  const globalStateJson = truncateGlobalStateForPrompt(globalState);
  if (globalStateJson) {
    sections.push('');
    sections.push('## Previously Collected Data');
    sections.push(
      'The following data has been collected by earlier steps in this workflow. ' +
        'Use it as context when completing your task.',
    );
    sections.push('```json');
    sections.push(globalStateJson);
    sections.push('```');
  }

  if (context && context.item != null) {
    sections.push('');
    sections.push('## Item of Interest');
    sections.push(`- **Index**: ${context.itemIndex ?? ''}`);
    sections.push(`- **Item**: ${JSON.stringify(context.item)}`);
  }

  // const downloadedFilesSection = buildSessionDownloadedFilesSection(downloadedFiles);
  // if (downloadedFilesSection) {
  //   sections.push('');
  //   sections.push(downloadedFilesSection);
  // }

  console.log(sections.join('\n'));

  return sections.join('\n');
}
