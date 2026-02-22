import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LoopContext } from '../types';
import OpenAI from 'openai';
import {
  buildExtractInformationPrompt,
  ExtractInformationParams,
} from './prompts/extract-information';

const DEFAULT_MAX_TOKENS = 20000;

type SchemaMap = Record<string, string>;

export type ParsedSchema = {
  raw: string;
  properties: SchemaMap;
};

export type ExtractOutput = {
  scraped_data: any;
};

type LoadPromptParams = Omit<ExtractInformationParams, 'elements'> & {
  element_tree_builder: ElementTreeBuilder;
  html_need_skyvern_attrs?: boolean;
};

type LlmExtractParams = {
  llmClient: OpenAI;
  model: string;
  page: any;
  dataExtractionGoal: string;
  schema?: ParsedSchema | null;
  schemaJsonOverride?: ZodTypeAny | null;
  skipValidation?: boolean;
  context?: LoopContext;
  extractedVariables?: Record<string, string>;
};

export function parseSchemaMap(schemaText?: string): ParsedSchema | null {
  if (!schemaText) return null;
  const trimmed = schemaText.trim();
  if (!trimmed) return null;

  const tryParse = (text: string): SchemaMap | null => {
    try {
      const parsed = JSON.parse(text) as SchemaMap;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) {
    return { raw: JSON.stringify(direct, null, 2), properties: direct };
  }

  const normalized = trimmed.replace(/([a-zA-Z0-9_]+)\s*:/g, '"$1":').replace(/'/g, '"');

  const parsed = tryParse(normalized);
  if (!parsed) return null;
  return { raw: JSON.stringify(parsed, null, 2), properties: parsed };
}

export function buildJsonSchemaFromMap(schema: ParsedSchema): string {
  const properties: Record<string, { type: string }> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(schema.properties)) {
    const normalized = String(value || 'string').toLowerCase();
    let type = 'string';
    if (['number', 'integer'].includes(normalized)) type = 'number';
    if (['boolean', 'bool'].includes(normalized)) type = 'boolean';
    if (['array', 'list'].includes(normalized)) type = 'array';
    if (['object', 'dict', 'map'].includes(normalized)) type = 'object';
    properties[key] = { type };
    required.push(key);
  }

  const jsonSchema = {
    type: 'object',
    properties,
    required,
  };

  return JSON.stringify(jsonSchema, null, 2);
}

export function validateAndFillExtractionResult(
  extractionResult: any,
  schema: ParsedSchema,
): Record<string, any> {
  const output: Record<string, any> = {};
  const resultObj =
    extractionResult && typeof extractionResult === 'object' && !Array.isArray(extractionResult)
      ? extractionResult
      : {};

  for (const key of Object.keys(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(resultObj, key)) {
      output[key] = resultObj[key];
    } else {
      output[key] = null;
    }
  }

  return output;
}

export function normalizeLoopItems(extractionResult: any): { items: Array<{ text: string }> } {
  if (Array.isArray(extractionResult)) {
    return {
      items: extractionResult.map((item) => {
        if (item == null) return { text: '' };
        if (typeof item === 'string') return { text: item };
        if (typeof item === 'number' || typeof item === 'boolean') {
          return { text: String(item) };
        }
        if (typeof item === 'object') {
          if ('text' in item && item.text != null) {
            return { text: String((item as any).text) };
          }
          const firstStringValue = Object.values(item).find((v) => typeof v === 'string');
          if (firstStringValue) {
            return { text: String(firstStringValue) };
          }
          return { text: JSON.stringify(item) };
        }
        return { text: String(item) };
      }),
    };
  }

  const rawItems = extractionResult?.items;
  if (!Array.isArray(rawItems)) {
    return { items: [] };
  }

  const items = rawItems.map((item) => {
    if (item == null) return { text: '' };
    if (typeof item === 'string') return { text: item };
    if (typeof item === 'number' || typeof item === 'boolean') {
      return { text: String(item) };
    }
    if (typeof item === 'object') {
      if ('text' in item && item.text != null) {
        return { text: String((item as any).text) };
      }
      const firstStringValue = Object.values(item).find((v) => typeof v === 'string');
      if (firstStringValue) {
        return { text: String(firstStringValue) };
      }
      return { text: JSON.stringify(item) };
    }
    return { text: String(item) };
  });

  return { items };
}

export async function extractWithLlm(params: LlmExtractParams): Promise<ExtractOutput> {
  const {
    llmClient,
    model,
    page,
    dataExtractionGoal,
    schema,
    schemaJsonOverride,
    skipValidation,
    context,
    extractedVariables,
  } = params;

  const currentUrl = page.url();
  const extractedText = await page.evaluate(() => document.body?.innerText || '');
  let screenshotDataUrl: string | null = null;
  try {
    const screenshot = await page.screenshot({ fullPage: true });
    const base64 = Buffer.from(screenshot).toString('base64');
    screenshotDataUrl = `data:image/png;base64,${base64}`;
  } catch (error) {
    console.warn('[EXTRACT] Failed to capture screenshot:', (error as Error).message);
  }

  const elementTreeBuilder = new ElementTreeBuilder(page);

  const previousExtractedInformation =
    extractedVariables && Object.keys(extractedVariables).length > 0
      ? JSON.stringify(extractedVariables, null, 2)
      : null;

  const navigationPayload =
    context && context.item != null ? JSON.stringify(context.item, null, 2) : null;

  const schemaOverrideJson = schemaJsonOverride
    ? JSON.stringify(
        zodToJsonSchema(schemaJsonOverride as any, { target: 'jsonSchema7', $refStrategy: 'none' }),
        null,
        2,
      )
    : null;

  const prompt = await loadPromptWithElements({
    element_tree_builder: elementTreeBuilder,
    html_need_skyvern_attrs: false,
    data_extraction_goal: dataExtractionGoal,
    extracted_information_schema:
      schemaOverrideJson ?? (schema ? buildJsonSchemaFromMap(schema) : null),
    previous_extracted_information: previousExtractedInformation,
    navigation_goal: null,
    current_url: currentUrl,
    extracted_text: extractedText,
    error_code_mapping_str: null,
  });

  const messages: any[] = [
    {
      role: 'system',
      content: 'You are a data extraction assistant. Return only the JSON object.',
    },
  ];

  if (screenshotDataUrl) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: screenshotDataUrl } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const response = await llmClient.chat.completions.create({
    model,
    messages,
  });

  let rawContent: any = response.choices[0]?.message?.content ?? '';

  if (Array.isArray(rawContent)) {
    rawContent = rawContent
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('');
  }

  let jsonResponse: any = rawContent;
  if (typeof rawContent === 'string') {
    jsonResponse = parseJsonFromText(rawContent);
  }

  if (schema && !skipValidation) {
    jsonResponse = validateAndFillExtractionResult(jsonResponse, schema);
  }

  return {
    scraped_data: jsonResponse,
  };
}

export async function loadPromptWithElements(params: LoadPromptParams): Promise<string> {
  const { element_tree_builder, html_need_skyvern_attrs = true, ...promptParams } = params;
  const elements = await element_tree_builder.buildElementTree(html_need_skyvern_attrs);
  let prompt = renderPromptTemplate('extract-information', { ...promptParams, elements });

  const tokenCount = countTokens(prompt);
  if (tokenCount > DEFAULT_MAX_TOKENS && element_tree_builder.supportEconomyElementsTree()) {
    const economyElements =
      await element_tree_builder.buildEconomyElementsTree(html_need_skyvern_attrs);
    prompt = renderPromptTemplate('extract-information', {
      ...promptParams,
      elements: economyElements,
    });
    const economyTokenCount = countTokens(prompt);
    console.warn(
      '[EXTRACT] Prompt too long; using economy elements tree.',
      JSON.stringify({
        token_count: tokenCount,
        economy_token_count: economyTokenCount,
        max_tokens: DEFAULT_MAX_TOKENS,
      }),
    );

    if (economyTokenCount > DEFAULT_MAX_TOKENS) {
      const economyElementsDumped = await element_tree_builder.buildEconomyElementsTree(
        html_need_skyvern_attrs,
        2 / 3,
      );
      prompt = renderPromptTemplate('extract-information', {
        ...promptParams,
        elements: economyElementsDumped,
      });
      const tokenCountAfterDump = countTokens(prompt);
      console.warn(
        '[EXTRACT] Prompt still too long; keeping first 2/3 of HTML context.',
        JSON.stringify({
          token_count: tokenCount,
          economy_token_count: economyTokenCount,
          token_count_after_dump: tokenCountAfterDump,
          max_tokens: DEFAULT_MAX_TOKENS,
        }),
      );
    }
  }

  return prompt;
}

function renderPromptTemplate(_templateName: string, params: ExtractInformationParams): string {
  return buildExtractInformationPrompt(params);
}

function parseJsonFromText(text: string): any {
  let trimmed = text.trim();
  if (!trimmed) return {};

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    trimmed = fenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const substring = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(substring);
    } catch {
      // fallthrough
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Failed to parse JSON from LLM response: ${(error as Error).message}`);
  }
}

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

class ElementTreeBuilder {
  private page: any;

  constructor(page: any) {
    this.page = page;
  }

  async buildElementTree(htmlNeedSkyvernAttrs: boolean = true): Promise<string> {
    return this.buildElementsSnapshot(htmlNeedSkyvernAttrs);
  }

  async buildEconomyElementsTree(
    htmlNeedSkyvernAttrs: boolean = true,
    percentToKeep: number = 1,
  ): Promise<string> {
    return this.buildElementsSnapshot(htmlNeedSkyvernAttrs, percentToKeep);
  }

  supportEconomyElementsTree(): boolean {
    return true;
  }

  private async buildElementsSnapshot(
    htmlNeedSkyvernAttrs: boolean,
    percentToKeep: number = 1,
  ): Promise<string> {
    void htmlNeedSkyvernAttrs;
    let elements: Array<Record<string, string>> = [];
    try {
      elements = (await this.page.evaluate((keepPercent: number) => {
        try {
          const selectors = [
            'a',
            'button',
            'input',
            'select',
            'textarea',
            '[role="button"]',
            '[onclick]',
            '[tabindex]',
          ];
          const seen = new Set<Element>();
          const elements: Array<Record<string, string>> = [];

          const getXPath = (element: Element): string => {
            if ((element as HTMLElement).id) {
              return `//*[@id="${(element as HTMLElement).id}"]`;
            }
            const parts: string[] = [];
            let current: Element | null = element;
            while (current && current.nodeType === 1 && current !== document.body) {
              let index = 1;
              let sibling = current.previousElementSibling;
              while (sibling) {
                if (sibling.tagName === current.tagName) {
                  index += 1;
                }
                sibling = sibling.previousElementSibling;
              }
              parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
              current = current.parentElement;
            }
            return '/' + parts.join('/');
          };

          const collect = (el: Element) => {
            if (seen.has(el)) return;
            seen.add(el);
            const tag = el.tagName.toLowerCase();
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            const ariaLabel = el.getAttribute('aria-label') || '';
            const role = el.getAttribute('role') || '';
            const type = el.getAttribute('type') || '';
            const name = el.getAttribute('name') || '';
            const placeholder = el.getAttribute('placeholder') || '';
            const value = (el as HTMLInputElement).value || '';
            const href = el.getAttribute('href') || '';
            const xpath = getXPath(el);

            elements.push({
              tag,
              text,
              ariaLabel,
              role,
              type,
              name,
              placeholder,
              value,
              href,
              xpath,
            });
          };

          selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach(collect);
          });

          const limitedCount = Math.max(1, Math.floor(elements.length * keepPercent));
          return elements.slice(0, limitedCount);
        } catch {
          return [];
        }
      }, percentToKeep)) as Array<Record<string, string>>;
    } catch (error) {
      console.warn('[EXTRACT] Failed to build elements tree:', (error as Error).message);
      return '';
    }

    return elements
      .map((el) => {
        const attrs = [
          `tag="${el.tag}"`,
          el.text ? `text="${el.text}"` : '',
          el.ariaLabel ? `aria-label="${el.ariaLabel}"` : '',
          el.role ? `role="${el.role}"` : '',
          el.type ? `type="${el.type}"` : '',
          el.name ? `name="${el.name}"` : '',
          el.placeholder ? `placeholder="${el.placeholder}"` : '',
          el.value ? `value="${el.value}"` : '',
          el.href ? `href="${el.href}"` : '',
          el.xpath ? `xpath="${el.xpath}"` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `- ${attrs}`;
      })
      .join('\n');
  }
}
