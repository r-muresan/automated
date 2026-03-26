import type { AgentToolMode, Variables } from '../../types/public/agent.js';

type SpreadsheetProvider = 'google_sheets' | 'excel_web';

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function getSpreadsheetProvider(url: string): SpreadsheetProvider | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // Google Sheets
  if (
    (host === 'docs.google.com' || host === 'sheets.google.com') &&
    /^\/spreadsheets\/d\/[^/]+(?:\/|$)/i.test(path)
  ) {
    return 'google_sheets';
  }

  // Excel Web
  const isExcelHost =
    host === 'excel.office.com' ||
    host === 'excel.officeapps.live.com' ||
    /^excel\\.[a-z0-9.-]*officeapps\\.live\\.com$/i.test(host) ||
    host === 'excel.cloud.microsoft' ||
    host === 'office.live.com' ||
    host === 'www.office.com' ||
    host === 'onedrive.live.com' ||
    host === 'office.com';
  if (isExcelHost) {
    const query = parsed.search.toLowerCase();
    const hash = parsed.hash.toLowerCase();
    const lowerPath = path.toLowerCase();
    const workbookParamKeys = [
      'docid',
      'resid',
      'id',
      'file',
      'wopisrc',
      'itemid',
      'driveid',
      'sourcedoc',
    ];
    const hasWorkbookQueryParam = workbookParamKeys.some(
      (key) => parsed.searchParams.has(key) || query.includes(`${key}=`),
    );
    const hasWorkbookHashParam = workbookParamKeys.some((key) => hash.includes(`${key}=`));
    const hasWorkbookPathMarker =
      /^\/open\/(onedrive|sharepoint)\//.test(lowerPath) ||
      /^\/x\//.test(lowerPath) ||
      lowerPath.includes('xlviewer') ||
      lowerPath.includes('/workbook');
    if (hasWorkbookQueryParam || hasWorkbookHashParam || hasWorkbookPathMarker) {
      return 'excel_web';
    }
  }

  return null;
}

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

export interface AgentSystemPromptOptions {
  url: string;
  executionInstruction: string;
  mode: AgentToolMode;
  systemInstructions?: string;
  /** Whether running on Browserbase (enables captcha solver messaging) */
  isBrowserbase?: boolean;
  /** Tools to exclude from the system prompt */
  excludeTools?: string[];
  /** Variables available to the agent for use in act/type tools */
  variables?: Variables;
  /** Previously collected data from earlier workflow steps */
  globalState?: any[];
}

/**
 * Builds the system prompt for the agent based on the tool mode.
 *
 * @param options - The prompt configuration options
 * @returns The formatted system prompt string
 */
interface ToolDefinition {
  name: string;
  description: string;
}

function buildToolsSection(
  isHybridMode: boolean,
  hasSearch: boolean,
  excludeTools?: string[],
): string {
  const excludeSet = new Set(excludeTools ?? []);

  const hybridTools: ToolDefinition[] = [
    {
      name: 'screenshot',
      description: 'Take a compressed JPEG screenshot for quick visual context',
    },
    {
      name: 'ariaTree',
      description: 'Get an accessibility (ARIA) hybrid tree for full page context',
    },
    {
      name: 'click',
      description:
        'Click on an element (PREFERRED - more reliable when element is visible in viewport)',
    },
    {
      name: 'type',
      description:
        'Type text into an element (PREFERRED - more reliable when element is visible in viewport)',
    },
    {
      name: 'act',
      description:
        'Perform a specific atomic action (click, type, etc.) - ONLY use when element is in ariaTree but NOT visible in screenshot. Less reliable but can interact with out-of-viewport elements.',
    },
    { name: 'dragAndDrop', description: 'Drag and drop an element' },
    { name: 'clickAndHold', description: 'Click and hold on an element' },
    { name: 'keys', description: 'Press a keyboard key' },
    {
      name: 'fillFormVision',
      description: 'Fill out a form using coordinates',
    },
    { name: 'think', description: 'Think about the task' },
    { name: 'goto', description: 'Navigate to a URL' },
    { name: 'wait', description: 'Wait for a specified time' },
    { name: 'navback', description: 'Navigate back in browser history' },
    { name: 'scroll', description: 'Scroll the page x pixels up or down' },
    {
      name: 'request_user_credentials',
      description:
        "Request user credentials when encountering a login, 2FA, CAPTCHA, passkey, or any credential gate that requires the user's secrets. Only use as a last resort when you cannot proceed on your own.",
    },
  ];

  const domTools: ToolDefinition[] = [
    {
      name: 'screenshot',
      description: 'Take a compressed JPEG screenshot for quick visual context',
    },
    {
      name: 'ariaTree',
      description: 'Get an accessibility (ARIA) hybrid tree for full page context',
    },
    {
      name: 'act',
      description: 'Perform a specific atomic action (click, type)',
    },
    { name: 'keys', description: 'Press a keyboard key' },
    { name: 'fillForm', description: 'Fill out a form' },
    { name: 'think', description: 'Think about the task' },
    { name: 'goto', description: 'Navigate to a URL' },
    { name: 'wait', description: 'Wait for a specified time' },
    { name: 'navback', description: 'Navigate back in browser history' },
    { name: 'scroll', description: 'Scroll the page x pixels up or down' },
    {
      name: 'request_user_credentials',
      description:
        "Request user credentials when encountering a login, 2FA, CAPTCHA, passkey, or any credential gate that requires the user's secrets. Only use as a last resort when you cannot proceed on your own.",
    },
  ];

  const baseTools = isHybridMode ? hybridTools : domTools;

  if (hasSearch) {
    baseTools.push({
      name: 'search',
      description:
        'Perform a web search and return results. Prefer this over navigating to Google and searching within the page for reliability and efficiency.',
    });
  }

  const filteredTools = baseTools.filter((tool) => !excludeSet.has(tool.name));

  const toolLines = filteredTools
    .map((tool) => `    <tool name="${tool.name}">${tool.description}</tool>`)
    .join('\n');

  return `<tools>\n${toolLines}\n  </tools>`;
}

export function buildAgentSystemPrompt(options: AgentSystemPromptOptions): string {
  const { url, executionInstruction, mode, systemInstructions, excludeTools, variables, globalState } = options;
  const localeDate = new Date().toLocaleDateString();
  const isoDate = new Date().toISOString();
  const cdata = (text: string) => `<![CDATA[${text}]]>`;

  const isHybridMode = mode === 'hybrid';
  const hasSearch = Boolean(process.env.BRAVE_API_KEY);

  // Tools section differs based on mode and excluded tools
  const toolsSection = buildToolsSection(isHybridMode, hasSearch, excludeTools);

  // Strategy differs based on mode
  const strategyItems = isHybridMode
    ? [
        `<item>Tool selection priority: Use specific tools (click, type) when elements are visible in viewport for maximum reliability.</item>`,
        `<item>Always use screenshot to get proper grounding of the coordinates you want to type/click into.</item>`,
        `<item>When interacting with an input, always use the type tool to type into the input, over clicking and then typing into it.</item>`,
        `<item>Use ariaTree as a secondary tool when elements aren't visible in screenshot or to get full page context.</item>`,
        `<item>Only use act when element is in ariaTree but NOT visible in screenshot.</item>`,
      ]
    : [
        `<item>Tool selection priority: Use act tool for all clicking and typing on a page.</item>`,
        `<item>Always check ariaTree first to understand full page content without scrolling - it shows all elements including those below the fold.</item>`,
        `<item>When interacting with an input, always use the act tool to type into the input, over clicking and then typing.</item>`,
        `<item>If an element is present in the ariaTree, use act to interact with it directly - this eliminates the need to scroll.</item>`,
        `<item>Use screenshot for visual confirmation when needed, but rely primarily on ariaTree for element detection.</item>`,
      ];

  const strategySection = strategyItems.join('\n    ');

  const commonStrategyItems = `
    <item>Keep actions atomic and verify outcomes before proceeding.</item>
    <item>For each action, keep reasoning minimal: one short sentence only when necessary.</item>
    <item>When you need to input text that could be entered character-by-character or through multiple separate inputs, prefer using the keys tool to type the entire sequence at once. This is more efficient for scenarios like verification codes split across multiple fields, or when virtual keyboards are present but direct typing would be faster.</item>
    `;

  // Page understanding protocol differs based on mode
  const pageUnderstandingProtocol = isHybridMode
    ? `<page_understanding_protocol>
    <step_1>
      <title>UNDERSTAND THE PAGE</title>
      <primary_tool>
        <name>screenshot</name>
        <usage>Visual confirmation when needed. Ideally after navigating to a new page.</usage>
        </primary_tool>
      <secondary_tool>
        <name>ariaTree</name>
        <usage>Get complete page context before taking actions</usage>
        <benefit>Eliminates the need to scroll and provides full accessible content</benefit>
      </secondary_tool>
    </step_1>
  </page_understanding_protocol>`
    : `<page_understanding_protocol>
    <step_1>
      <title>UNDERSTAND THE PAGE</title>
      <primary_tool>
        <name>ariaTree</name>
        <usage>Get complete page context before taking actions</usage>
        <benefit>Eliminates the need to scroll and provides full accessible content</benefit>
        </primary_tool>
      <secondary_tool>
        <name>screenshot</name>
        <usage>Visual confirmation when needed. Ideally after navigating to a new page.</usage>
      </secondary_tool>
    </step_1>
  </page_understanding_protocol>`;

  const roadblocksSection = `<roadblocks>
    <note>captchas, popups, logins, etc.</note>
    <captcha>If you see a captcha, use the wait tool. It will automatically be solved by our internal solver.</captcha>
    <credentials>If you hit a login, 2FA, passkey, or any credential gate that requires the user's secrets, call the request_user_credentials tool with a concise reason and wait. Only use this as a last resort when you cannot proceed on your own.</credentials>
  </roadblocks>`;

  // Detect spreadsheet provider from the URL
  const spreadsheetProvider = getSpreadsheetProvider(url);
  const spreadsheetSection = spreadsheetProvider
    ? `\n  <spreadsheet>\n    ${buildSpreadsheetInstructions(spreadsheetProvider)}\n  </spreadsheet>`
    : '';

  // Build collected data section from global state
  const globalStateJson = truncateGlobalStateForPrompt(globalState ?? []);
  const collectedDataSection = globalStateJson
    ? `\n  <collectedData>
    <note>The following data has been collected by earlier steps in this workflow. Use it as context when completing your task.</note>
    <data>${cdata(globalStateJson)}</data>
  </collectedData>`
    : '';

  // Build customInstructions block only if provided
  const customInstructionsBlock = systemInstructions
    ? `<customInstructions>${cdata(systemInstructions)}</customInstructions>\n  `
    : '';

  // Build variables section only if variables are provided
  const hasVariables = variables && Object.keys(variables).length > 0;
  const variableToolsNote = isHybridMode
    ? "Use %variableName% syntax in the type, fillFormVision, or act tool's value/text/action fields."
    : "Use %variableName% syntax in the act or fillForm tool's value/action fields.";
  const variablesSection = hasVariables
    ? `<variables>
    <note>You have access to the following variables. Use %variableName% syntax to substitute variable values. This is especially important for sensitive data like passwords.</note>
    <usage>${variableToolsNote}</usage>
    <example>To type a password, use: type %password% into the password field</example>
    ${Object.entries(variables)
      .map(([name, v]) => {
        const description =
          typeof v === 'object' && v !== null && 'value' in v ? v.description : undefined;
        return description
          ? `<variable name="${name}">${description}</variable>`
          : `<variable name="${name}" />`;
      })
      .join('\n    ')}
  </variables>`
    : '';

  return `<system>
  <identity>You are a web automation assistant using browser automation tools to accomplish the user's goal.</identity>
  ${customInstructionsBlock}<task>
    <goal>${cdata(executionInstruction)}</goal>
    <date display="local" iso="${isoDate}">${localeDate}</date>
    <note>You may think the date is different due to knowledge cutoff, but this is the actual date.</note>
  </task>
  <page>
    <startingUrl>you are starting your task on this url: ${url}</startingUrl>${spreadsheetProvider ? `\n    <note>The current page is a ${spreadsheetProvider === 'google_sheets' ? 'Google Sheets' : 'Excel Web'} spreadsheet. Prefer spreadsheet tools over manual browser interactions.</note>` : ''}
  </page>${spreadsheetSection}
  <mindset>
    <note>Be very intentional about your action. The initial instruction is very important, and slight variations of the actual goal can lead to failures.</note>

    <note>When the task is complete, do not seek more information; you have completed the task.</note>
  </mindset>
  <strategic_thinking>
    <principle>Before acting, use the think tool to reason about the smartest way to accomplish your goal. Think like an expert human would — not mechanically, but creatively and efficiently.</principle>
    <rule>Apply your world knowledge and domain expertise to every decision. You know more than the literal task description — use that knowledge to make better choices about what to type, where to navigate, and how to approach problems.</rule>
    <rule>Always choose the most direct path. If there is a way to skip steps, narrow results, or arrive at the answer faster, take it.</rule>
    <rule>If your current approach feels inefficient or repetitive, stop and rethink. Use the think tool to consider whether there is a fundamentally better strategy before continuing.</rule>
  </strategic_thinking>
  <guidelines>
    <item>Always start by understanding the current page state</item>
    <item>Use the screenshot tool to verify page state when needed</item>
    <item>Use appropriate tools for each action</item>
  </guidelines>
  ${pageUnderstandingProtocol}
  <navigation>
    <rule>If you are confident in the URL, navigate directly to it.</rule>
    ${hasSearch ? `<rule>If you are not confident in the URL, use the search tool to find it.</rule>` : ``}
  </navigation>
  ${toolsSection}
  <strategy>
    ${strategySection}
    ${commonStrategyItems}
  </strategy>
  ${roadblocksSection}
  ${variablesSection}${collectedDataSection}
</system>`;
}

// <completion>
// <note>When you complete the task, explain any information that was found that was relevant to the original task.</note>
// <examples>
//   <example>If you were asked for specific flights, list the flights you found.</example>
//   <example>If you were asked for information about a product, list the product information you were asked for.</example>
// </examples>
// </completion>
