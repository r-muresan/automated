import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Workflow } from 'apps/cua-agent/types';
import type { InteractionPayload } from '@automated/api-dtos';
import {
  createOpenRouterOpenAIClient,
  generateWorkflowFromUserParts,
  getOpenRouterProviderConfig,
} from './workflow-generation.shared';

type InferWorkflowInputsFromEmailArgs = {
  workflowTitle: string;
  workflowInputs: string[];
  email: {
    from: string;
    to: string[];
    subject?: string | null;
    text?: string | null;
    html?: string | null;
    headers?: unknown;
    attachments?: unknown;
  };
};

const EMAIL_INPUT_INFERENCE_SYSTEM_PROMPT = `You infer workflow input values from inbound emails.

You will receive:
- Workflow title
- Workflow input names
- Email metadata (from/to/subject)
- Email text + html body
- Email headers
- Email attachments metadata/content when available

Rules:
- Return only inputs that can be inferred with useful confidence.
- Keep each value concise but complete.
- Preserve critical formatting when present (emails, phone numbers, IDs, dates, URLs).
- Use attachment content when it helps infer values.
- Do not invent values from unrelated assumptions.
`;

@Injectable()
export class WorkflowGenerationService {
  async generateWorkflowFromInteractions(
    interactions: InteractionPayload[],
  ): Promise<{ workflow: Workflow; rawResponse: string; userParts: any[]; usage?: any }> {
    const userParts = this.buildUserParts(interactions);
    await this.writeUserPartsLog(userParts);

    const result = await generateWorkflowFromUserParts({
      userParts,
      modelName: 'google/gemini-3-flash-preview',
    });

    return {
      workflow: result.workflow,
      rawResponse: result.rawResponse,
      userParts,
      usage: result.usage,
    };
  }

  async inferWorkflowInputsFromEmail(
    args: InferWorkflowInputsFromEmailArgs,
  ): Promise<{ inputValues: Record<string, string>; rawResponse: string; usage?: any }> {
    const workflowInputs = args.workflowInputs
      .map((input) => input.trim())
      .filter((input) => input.length > 0);

    if (workflowInputs.length === 0) {
      return {
        inputValues: {},
        rawResponse: '{}',
      };
    }

    const client = createOpenRouterOpenAIClient();
    const provider = getOpenRouterProviderConfig();
    const modelName = process.env.OPENROUTER_MODEL ?? 'google/gemini-3-flash-preview';

    const response = await client.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: EMAIL_INPUT_INFERENCE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: this.buildEmailInferencePrompt({
            workflowTitle: args.workflowTitle,
            workflowInputs,
            email: args.email,
          }),
        },
        {
          role: 'user',
          content: this.buildInputInferenceSchemaPrompt(workflowInputs),
        },
      ],
      response_format: { type: 'json_object' },
      provider,
    } as any);

    const generatedText = response.choices?.[0]?.message?.content;
    if (!generatedText) {
      throw new Error('No text in OpenRouter response.');
    }

    const parsed = JSON.parse(generatedText);
    const candidateMap = this.extractCandidateInputValues(parsed);
    const inputValues = this.normalizeInferredInputValues(workflowInputs, candidateMap);

    return { inputValues, rawResponse: generatedText, usage: response.usage };
  }

  private buildUserParts(interactions: InteractionPayload[]): any[] {
    const userParts: any[] = [];

    for (let i = 0; i < interactions.length; i++) {
      const interaction = interactions[i];
      const parts: string[] = [];
      parts.push(`Step ${i + 1}:`);

      if (interaction.data?.type === 'starting_url') {
        parts.push(`  Type: Starting URL`);
        parts.push(`  URL: ${interaction.element?.href || 'unknown'}`);
      } else if (interaction.data?.type === 'click') {
        parts.push(`  Type: Click`);
        if (interaction.element?.text) parts.push(`  Text: ${interaction.element.text}`);
      } else if (interaction.data?.type === 'keydown') {
        parts.push(`  Type: Typing`);
        if (interaction.element?.text) parts.push(`  Typed: "${interaction.element.text}"`);
      } else if (interaction.data?.type === 'keypress') {
        parts.push(`  Type: Key Press`);
        if (interaction.data?.combo) parts.push(`  Keys: ${interaction.data.combo}`);
        else if (interaction.element?.text) parts.push(`  Keys: ${interaction.element.text}`);
      } else if (interaction.type === 'frame_navigation') {
        parts.push(`  Type: Navigate`);
        parts.push(`  URL: ${interaction.data?.url || interaction.element?.href || 'unknown'}`);
      } else if (interaction.type === 'tab_navigation') {
        parts.push(`  Type: Tab Navigation`);
        if (interaction.data?.url) parts.push(`  URL: ${interaction.data.url}`);
      }

      if (interaction.transcript) {
        parts.push(`  Voice narration: "${interaction.transcript}"`);
      }

      userParts.push({ type: 'text', text: parts.join('\n') });

      if (interaction.screenshotUrl) {
        try {
          let base64Data = interaction.screenshotUrl;
          let mimeType = 'image/png';

          if (base64Data.startsWith('data:')) {
            const match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              mimeType = match[1];
              base64Data = match[2];
            }
          }

          userParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Data}`,
            },
          });
        } catch (error) {
          console.error(`[WORKFLOW] Failed to process screenshot for step ${i + 1}:`, error);
        }
      }
    }

    return userParts;
  }

  private async writeUserPartsLog(userParts: any[]): Promise<void> {
    try {
      const logsDir = path.join(process.cwd(), 'apps/backend/logs');
      await fs.mkdir(logsDir, { recursive: true });
      const logFilePath = path.join(logsDir, `interactions-${Date.now()}.json`);
      await fs.writeFile(logFilePath, JSON.stringify(userParts, null, 2));
      console.log(`[WORKFLOW] Saved interaction parts to ${logFilePath}`);
    } catch (error) {
      console.error(`[WORKFLOW] Failed to save interaction parts:`, error);
    }
  }

  private buildEmailInferencePrompt(args: InferWorkflowInputsFromEmailArgs): string {
    const emailText = this.truncateText(args.email.text, 12_000);
    const emailHtml = this.truncateText(args.email.html, 8_000);

    return [
      `Workflow title: ${args.workflowTitle}`,
      `Workflow inputs (use these exact names): ${JSON.stringify(args.workflowInputs)}`,
      `Email from: ${args.email.from}`,
      `Email to: ${JSON.stringify(args.email.to ?? [])}`,
      `Email subject: ${args.email.subject ?? ''}`,
      `Email text body:\n${emailText}`,
      `Email html body:\n${emailHtml}`,
      `Email headers (sanitized):\n${this.serializeForPrompt(args.email.headers)}`,
      `Email attachments (sanitized):\n${this.serializeForPrompt(args.email.attachments)}`,
    ].join('\n\n');
  }

  private buildInputInferenceSchemaPrompt(workflowInputs: string[]): string {
    const inputProperties = Object.fromEntries(
      workflowInputs.map((inputName) => [inputName, { type: 'string' }]),
    );
    const schema = {
      type: 'object',
      required: ['inputValues'],
      properties: {
        inputValues: {
          type: 'object',
          additionalProperties: false,
          properties: inputProperties,
        },
      },
    };

    return `Respond with valid JSON matching this schema:
${JSON.stringify(schema, null, 2)}

Only include keys in inputValues when you can infer a useful value.`;
  }

  private extractCandidateInputValues(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
      return {};
    }

    const record = value as Record<string, unknown>;
    if (record.inputValues && typeof record.inputValues === 'object') {
      return record.inputValues as Record<string, unknown>;
    }

    return record;
  }

  private normalizeInferredInputValues(
    workflowInputs: string[],
    inferredValues: Record<string, unknown>,
  ): Record<string, string> {
    const normalizedNameToInput = new Map(
      workflowInputs.map((input) => [this.normalizeInputName(input), input]),
    );
    const result: Record<string, string> = {};

    for (const [rawKey, rawValue] of Object.entries(inferredValues)) {
      if (typeof rawValue !== 'string') continue;

      const exactMatch = workflowInputs.includes(rawKey) ? rawKey : null;
      const normalizedMatch = normalizedNameToInput.get(this.normalizeInputName(rawKey));
      const canonicalInput = exactMatch ?? normalizedMatch;
      if (!canonicalInput) continue;

      const value = rawValue.trim();
      if (!value) continue;
      result[canonicalInput] = value;
    }

    return result;
  }

  private normalizeInputName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private serializeForPrompt(value: unknown): string {
    if (value == null) return 'null';
    const sanitized = this.sanitizeForPrompt(value);
    const serialized = JSON.stringify(sanitized, null, 2);
    if (serialized.length <= 12_000) {
      return serialized;
    }
    return `${serialized.slice(0, 12_000)}\n... [truncated]`;
  }

  private sanitizeForPrompt(value: unknown, depth = 0): unknown {
    if (depth >= 5) return '[max-depth]';
    if (value == null) return value;

    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => this.sanitizeForPrompt(item, depth + 1));
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
      const objectResult: Record<string, unknown> = {};
      for (const [key, nestedValue] of entries) {
        objectResult[key] = this.sanitizeForPrompt(nestedValue, depth + 1);
      }
      return objectResult;
    }

    return String(value);
  }

  private sanitizeString(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) return '';

    const isLikelyBase64 =
      trimmed.length > 180 &&
      /^[A-Za-z0-9+/=\s]+$/.test(trimmed) &&
      !trimmed.includes(' ');
    if (isLikelyBase64) {
      return `[base64 omitted, length=${trimmed.length}]`;
    }

    return this.truncateText(trimmed, 1_200);
  }

  private truncateText(value: string | null | undefined, maxLength: number): string {
    const text = (value ?? '').trim();
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
  }
}
