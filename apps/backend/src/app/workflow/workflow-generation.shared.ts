import { z } from 'zod';
import OpenAI from 'openai';
import type { Workflow, Step } from 'apps/cua-agent';

export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3-flash-preview';

// Base step schemas (non-recursive)
const NavigateStepSchema = z.object({
  type: z.literal('navigate').describe('Navigate to a URL'),
  url: z.string().describe('The URL to navigate to'),
});

const TabNavigateStepSchema = z.object({
  type: z.literal('tab_navigate').describe('Open URL in new tab'),
  url: z.string().describe('The URL to open in a new tab'),
});

const SaveStepSchema = z.object({
  type: z.literal('save').describe('Save current state'),
  description: z.string().describe('What to save'),
});

const SingleStepSchema = z.object({
  type: z.literal('step').describe('A single logical step'),
  description: z
    .string()
    .describe(
      'The action to perform. Describe the logical outcome or the complete interaction sequence.',
    ),
});

const ExtractStepSchema = z.object({
  type: z.literal('extract').describe('Extract data from the page'),
  description: z
    .string()
    .describe('The specific data points to be extracted from the current page content'),
  dataSchema: z
    .string()
    .describe(
      'A TypeScript interface or object schema defining the structure of the data to extract',
    )
    .optional(),
});

// Recursive step schema (supports nested loops/conditionals)
export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion('type', [
    NavigateStepSchema,
    TabNavigateStepSchema,
    SaveStepSchema,
    SingleStepSchema,
    ExtractStepSchema,
    z.object({
      type: z.literal('loop').describe('Repeat steps for each item'),
      description: z.string().describe('What to loop over'),
      steps: z.array(StepSchema).describe('Array of step objects to execute in each iteration'),
    }),
    z.object({
      type: z.literal('conditional').describe('Execute steps based on condition'),
      condition: z.string().describe('The condition to evaluate'),
      trueSteps: z.array(StepSchema).describe('Steps to execute if condition is true'),
      falseSteps: z.array(StepSchema).optional().describe('Steps to execute if condition is false'),
    }),
  ]),
);

export const WorkflowSchema = z.object({
  name: z.string().describe('Name of the workflow'),
  inputs: z
    .array(z.string())
    .optional()
    .describe(
      'Array of input names required to run this workflow. For example, if the workflow adds a person to a CRM, inputs might be ["Name", "Email"]. Leave empty if the workflow needs no dynamic data.',
    ),
  steps: z.array(StepSchema).describe('Array of workflow steps'),
}) as z.ZodType<Workflow>;

export const WORKFLOW_SYSTEM_PROMPT = `You are a workflow generator. Analyze user interactions, screenshots, and audio transcripts to create a browser automation workflow.

# Inputs
If the workflow requires dynamic data that would change each time it runs, specify an "inputs" array of descriptive input names.
- Example: A workflow that adds a contact to a CRM might have inputs: ["Name", "Email", "Phone Number"]
- Example: A workflow that sends a message might have inputs: ["Recipient", "Message"]
- If the workflow always does the exact same thing with no variable data, leave inputs empty or omit it.
- In step descriptions, reference inputs using {{InputName}} syntax so they can be substituted at runtime.
- IMPORTANT: Only include inputs for data that genuinely varies between runs. Do not include inputs for URLs or fixed values visible in the recording.

# Step Types
- \`navigate\`: Go to a URL. Must be the first step.
- \`tab_navigate\`: Open a URL in a new tab.
- \`step\`: A single logical action — what you'd tell a person to do as one instruction. Include all relevant details (what to type, which option to select, what to click).
- \`extract\`: Extract data from the page for use in other steps.
- \`loop\`: Repeat steps over a collection. The loop identifies what to iterate over internally — do not add a separate \`extract\` step before it for the same data.
- \`conditional\`: Branch based on a condition (trueSteps / falseSteps).
- \`save\`: Save data to an output file.

# Step Granularity
A step is NOT a single browser event. It groups all interactions needed for one logical action.
- GOOD: "Search for 'wireless headphones' and submit", "Log in with username 'user@example.com' and password 'pass123'", "Send an email to john@example.com with subject 'Meeting' and body 'See you at 3pm'"
- BAD (too granular): "Click the search box", "Type 'headphones'", "Press Enter" — these should be one step.
- BAD (too vague): "Complete the process", "Handle the form" — always include specific values and actions.
`;

// Manual JSON schema since zod-to-json-schema doesn't support Zod 4.x
// Uses $defs with $ref for recursive step support
const WORKFLOW_JSON_SCHEMA = {
  type: 'object',
  required: ['name', 'steps'],
  $defs: {
    step: {
      oneOf: [
        {
          type: 'object',
          required: ['type', 'url'],
          properties: {
            type: { const: 'navigate', description: 'Navigate to a URL' },
            url: { type: 'string', description: 'The URL to navigate to' },
          },
        },
        {
          type: 'object',
          required: ['type', 'url'],
          properties: {
            type: { const: 'tab_navigate', description: 'Open URL in new tab' },
            url: { type: 'string', description: 'The URL to open in a new tab' },
          },
        },
        {
          type: 'object',
          required: ['type', 'description'],
          properties: {
            type: { const: 'step', description: 'A single logical step' },
            description: {
              type: 'string',
              description:
                'The action to perform. Describe the logical outcome or the complete interaction sequence.',
            },
          },
        },
        {
          type: 'object',
          required: ['type', 'description'],
          properties: {
            type: { const: 'extract', description: 'Extract data from the page' },
            description: {
              type: 'string',
              description: 'The specific data points to be extracted from the current page content',
            },
            dataSchema: {
              type: 'string',
              description:
                'A TypeScript interface or object schema defining the structure of the data to extract',
            },
          },
        },
        {
          type: 'object',
          required: ['type', 'description'],
          properties: {
            type: { const: 'save', description: 'Save current state' },
            description: { type: 'string', description: 'What to save' },
          },
        },
        {
          type: 'object',
          required: ['type', 'description', 'steps'],
          properties: {
            type: { const: 'loop', description: 'Repeat steps for each item' },
            description: { type: 'string', description: 'What to loop over' },
            steps: {
              type: 'array',
              description: 'Steps to execute in each iteration',
              items: { $ref: '#/$defs/step' },
            },
          },
        },
        {
          type: 'object',
          required: ['type', 'condition', 'trueSteps'],
          properties: {
            type: { const: 'conditional', description: 'Execute steps based on condition' },
            condition: { type: 'string', description: 'The condition to evaluate' },
            trueSteps: {
              type: 'array',
              description: 'Steps to execute if condition is true',
              items: { $ref: '#/$defs/step' },
            },
            falseSteps: {
              type: 'array',
              description: 'Steps to execute if condition is false',
              items: { $ref: '#/$defs/step' },
            },
          },
        },
      ],
    },
  },
  properties: {
    name: { type: 'string', description: 'Name of the workflow' },
    inputs: {
      type: 'array',
      description:
        'Array of input names required to run this workflow (e.g. ["Name", "Email"]). Omit if no dynamic data is needed.',
      items: { type: 'string' },
    },
    steps: {
      type: 'array',
      description: 'Array of workflow steps',
      items: { $ref: '#/$defs/step' },
    },
  },
};

export function buildWorkflowSchemaPrompt(): string {
  return `Respond with valid JSON matching this schema:
${JSON.stringify(WORKFLOW_JSON_SCHEMA, null, 2)}

Do not include any other text, formatting or markdown in your output. Only the JSON object itself.`;
}

type ProviderConfig = {
  order: string[];
  allow_fallbacks: boolean;
};

function parseProviderOrder(value?: string | null): string[] {
  if (!value) return ['google-vertex'];
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : ['google-vertex'];
}

function parseAllowFallbacks(value?: string | null): boolean {
  if (value == null) return true;
  const normalized = value.trim().toLowerCase();
  if (['0', 'false', 'no'].includes(normalized)) return false;
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  return true;
}

function buildOpenRouterHeaders(): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const siteUrl = process.env.OPENROUTER_SITE_URL;
  const appName = process.env.OPENROUTER_APP_NAME;

  if (siteUrl) headers['HTTP-Referer'] = siteUrl;
  if (appName) headers['X-Title'] = appName;

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function createOpenRouterOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY for OpenRouter');
  }

  const baseURL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const headers = buildOpenRouterHeaders();

  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: headers,
  });
}

export function getOpenRouterProviderConfig(): ProviderConfig {
  return {
    order: parseProviderOrder(process.env.OPENROUTER_PROVIDER_ORDER),
    allow_fallbacks: parseAllowFallbacks(process.env.OPENROUTER_ALLOW_FALLBACKS),
  };
}

const VALID_STEP_TYPES = new Set([
  'navigate',
  'tab_navigate',
  'save',
  'step',
  'extract',
  'loop',
  'conditional',
]);

function normalizeStep(step: any): any {
  if (!step || typeof step !== 'object' || !step.type) return step;

  // If the type isn't valid, convert to a 'step' type
  if (!VALID_STEP_TYPES.has(step.type)) {
    console.warn(`[WORKFLOW] Normalizing unknown step type "${step.type}" to "step"`);
    const description = step.description || step.url || step.condition || JSON.stringify(step);
    return { type: 'step', description };
  }

  // Recursively normalize inner steps of loop/conditional
  if (step.type === 'loop' && Array.isArray(step.steps)) {
    return { ...step, steps: step.steps.map((s: any) => normalizeStep(s)) };
  }
  if (step.type === 'conditional') {
    const result = { ...step };
    if (Array.isArray(step.trueSteps)) {
      result.trueSteps = step.trueSteps.map((s: any) => normalizeStep(s));
    }
    if (Array.isArray(step.falseSteps)) {
      result.falseSteps = step.falseSteps.map((s: any) => normalizeStep(s));
    }
    return result;
  }

  return step;
}

function normalizeWorkflowData(data: any): any {
  if (!data || !Array.isArray(data.steps)) return data;
  return {
    ...data,
    steps: data.steps.map((s: any) => normalizeStep(s)),
  };
}

export async function generateWorkflowFromUserParts(args: {
  userParts: any[];
  modelName?: string;
  systemPrompt?: string;
}): Promise<{ workflow: Workflow; rawResponse: string; usage?: any }> {
  const client = createOpenRouterOpenAIClient();
  const provider = getOpenRouterProviderConfig();
  const modelName = args.modelName ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
  const systemPrompt = args.systemPrompt ?? WORKFLOW_SYSTEM_PROMPT;
  const schemaPrompt = buildWorkflowSchemaPrompt();

  const response = await client.chat.completions.create({
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: args.userParts },
      { role: 'user', content: schemaPrompt },
    ],
    response_format: { type: 'json_object' },
    provider,
  } as any);

  const generatedText = response.choices?.[0]?.message?.content;
  if (!generatedText) {
    throw new Error('No text in OpenRouter response.');
  }

  const jsonData = JSON.parse(generatedText);

  // Handle case where LLM returns array of steps instead of workflow object
  let workflowData = jsonData;
  if (Array.isArray(jsonData)) {
    console.warn('[WORKFLOW] LLM returned array instead of object, wrapping in workflow');
    workflowData = {
      name: 'Generated Workflow',
      steps: jsonData,
    };
  } else if (jsonData.steps && !jsonData.name) {
    // Has steps but missing name
    workflowData = { ...jsonData, name: jsonData.name || 'Generated Workflow' };
  }

  // Normalize LLM output to fix invalid step types before Zod validation
  workflowData = normalizeWorkflowData(workflowData);

  const workflow = WorkflowSchema.parse(workflowData);
  return { workflow, rawResponse: generatedText, usage: response.usage };
}
