import { getSpreadsheetProvider } from './spreadsheet/detection';
import { SPREADSHEET_TOOL_NAMES } from './spreadsheet/constants';
export { SPREADSHEET_TOOL_NAMES };

export const ORCHESTRATOR_ALWAYS_ON_TOOL_NAMES = [
  'list_tabs',
  'switch_tab',
  'request_user_credentials',
] as const;

export const HYBRID_BASE_TOOL_NAMES = [
  'act',
  'ariaTree',
  'click',
  'clickAndHold',
  'dragAndDrop',
  'extract',
  'fillFormVision',
  'goto',
  'keys',
  'navback',
  'screenshot',
  'scroll',
  'think',
  'type',
  'wait',
] as const;

export function buildHybridActiveToolsForUrl(url: string): string[] {
  const activeTools = new Set<string>([...HYBRID_BASE_TOOL_NAMES, ...ORCHESTRATOR_ALWAYS_ON_TOOL_NAMES]);

  if (process.env.BRAVE_API_KEY) {
    activeTools.add('search');
  }

  if (getSpreadsheetProvider(url)) {
    for (const toolName of SPREADSHEET_TOOL_NAMES) {
      activeTools.add(toolName);
    }
  }

  return Array.from(activeTools);
}
