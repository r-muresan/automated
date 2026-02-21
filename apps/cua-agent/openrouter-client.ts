import { CustomOpenAIClient } from '@browserbasehq/stagehand';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import OpenAI from 'openai';

const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3-flash-preview';
const DEFAULT_PROVIDER_ORDER = ['google-vertex/global', 'google-vertexO'];

type OpenRouterProviderConfig = {
  order: string[];
  allow_fallbacks: boolean;
};

class OpenRouterOpenAIClient extends CustomOpenAIClient {
  private provider: OpenRouterProviderConfig;
  private languageModel: LanguageModelV2;
  private pricing: { inputPerMillion: number; outputPerMillion: number };

  private static totalInputTokens = 0;
  private static totalOutputTokens = 0;
  private static totalCost = 0;
  private static requestCount = 0;

  constructor({
    modelName,
    client,
    provider,
    baseURL,
    apiKey,
    headers,
  }: {
    modelName: string;
    client: OpenAI;
    provider: OpenRouterProviderConfig;
    baseURL: string;
    apiKey: string;
    headers?: Record<string, string>;
  }) {
    super({ modelName, client: client as any });
    this.provider = provider;
    this.pricing = getPricingForModel(modelName);
    const openrouter = createOpenAICompatible({
      name: 'openrouter',
      baseURL,
      apiKey,
      headers,
    });
    const baseModel = openrouter.chatModel(modelName);
    this.languageModel = this.wrapWithProviderOptions(baseModel);
  }

  override async createChatCompletion<T = any>(params: any): Promise<T> {
    const { options, ...rest } = params ?? {};
    const mergedOptions = {
      ...options,
      provider: options?.provider ?? this.provider,
      reasoning: options?.reasoning ?? {
        effort: 'low',
      },
    };

    const response = await super.createChatCompletion({
      ...rest,
      options: mergedOptions,
    });
    this.trackUsageFromResponse(response);
    return response as T;
  }

  getLanguageModel(): any {
    return this.languageModel;
  }

  private mergeProviderOptions(providerOptions?: Record<string, any>) {
    const merged = { ...(providerOptions ?? {}) };
    const existing = merged.openrouter ?? {};

    merged.openrouter = {
      ...existing,
      reasoning: existing.reasoning ?? {
        effort: 'low',
      },
      provider: {
        ...(this.provider ?? {}),
        ...(existing.provider ?? {}),
        order: existing.provider?.order ?? this.provider.order,
        allow_fallbacks: existing.provider?.allow_fallbacks ?? this.provider.allow_fallbacks,
      },
    };

    return merged;
  }

  private wrapWithProviderOptions(model: LanguageModelV2): LanguageModelV2 {
    const self = this;
    return {
      ...model,
      specificationVersion: model.specificationVersion,
      provider: model.provider,
      modelId: model.modelId,
      async doGenerate(options) {
        return model.doGenerate({
          ...options,
          providerOptions: self.mergeProviderOptions(options.providerOptions),
        });
      },
      async doStream(options) {
        return model.doStream({
          ...options,
          providerOptions: self.mergeProviderOptions(options.providerOptions),
        });
      },
    };
  }

  private trackUsageFromResponse(response: any) {
    const usage = response?.usage;
    if (!usage) return;

    const inputTokens =
      usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens ?? 0;
    const outputTokens =
      usage.completion_tokens ??
      usage.output_tokens ??
      usage.completionTokens ??
      usage.outputTokens ??
      0;

    this.trackUsage({ inputTokens, outputTokens });
  }

  private trackUsage(usage: { inputTokens: number; outputTokens: number }) {
    if (!usage) return;

    OpenRouterOpenAIClient.requestCount++;
    OpenRouterOpenAIClient.totalInputTokens += usage.inputTokens;
    OpenRouterOpenAIClient.totalOutputTokens += usage.outputTokens;

    const inputCost = (usage.inputTokens / 1_000_000) * this.pricing.inputPerMillion;
    const outputCost = (usage.outputTokens / 1_000_000) * this.pricing.outputPerMillion;
    const requestCost = inputCost + outputCost;
    OpenRouterOpenAIClient.totalCost += requestCost;

    console.log(
      `[TOKENS] Request #${OpenRouterOpenAIClient.requestCount} (${this.modelName}): ` +
        `+$${requestCost.toFixed(6)} | ` +
        `Cumulative: $${OpenRouterOpenAIClient.totalCost.toFixed(6)}`,
    );
  }

  getTokenStats() {
    return {
      model: this.modelName,
      requestCount: OpenRouterOpenAIClient.requestCount,
      totalInputTokens: OpenRouterOpenAIClient.totalInputTokens,
      totalOutputTokens: OpenRouterOpenAIClient.totalOutputTokens,
      totalCost: OpenRouterOpenAIClient.totalCost,
    };
  }
}

const MODEL_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'google/gemini-3-flash-preview': { inputPerMillion: 0.5, outputPerMillion: 3 },
  'google/gemini-3.0-flash-preview': { inputPerMillion: 0.5, outputPerMillion: 3 },
  'gemini-3-flash-preview': { inputPerMillion: 0.5, outputPerMillion: 3 },
};

function getPricingForModel(modelName: string) {
  return MODEL_PRICING[modelName] ?? { inputPerMillion: 0.5, outputPerMillion: 3 };
}

function parseProviderOrder(value?: string | null): string[] {
  if (!value) return DEFAULT_PROVIDER_ORDER;
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_PROVIDER_ORDER;
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

export function createOpenRouterClient(options?: { modelName?: string }): CustomOpenAIClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY for OpenRouter');
  }

  const modelName = options?.modelName ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
  const baseURL = process.env.OPENROUTER_BASE_URL ?? DEFAULT_OPENROUTER_BASE_URL;
  const headers = buildOpenRouterHeaders();

  const client = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: headers,
  });

  return new OpenRouterOpenAIClient({
    modelName,
    client: client as any,
    baseURL,
    apiKey,
    headers,
    provider: {
      order: parseProviderOrder(process.env.OPENROUTER_PROVIDER_ORDER),
      allow_fallbacks: parseAllowFallbacks(process.env.OPENROUTER_ALLOW_FALLBACKS),
    },
  });
}
