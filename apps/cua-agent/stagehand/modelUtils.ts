import { ClientOptions, ModelConfiguration } from "./v3/types/public/model.js";

//useful when resolving a model from string or object formats we accept
export function extractModelName(
  model?: string | { modelName: string; [key: string]: unknown },
): string | undefined {
  if (!model) return undefined;
  return typeof model === "string" ? model : model.modelName;
}

export function splitModelName(model: string): {
  provider: string;
  modelName: string;
} {
  const firstSlashIndex = model.indexOf("/");
  if (firstSlashIndex === -1) {
    return { provider: model, modelName: model };
  }
  const provider = model.substring(0, firstSlashIndex);
  const modelName = model.substring(firstSlashIndex + 1);
  return { provider, modelName };
}

export function resolveModel(model: string | ModelConfiguration): {
  provider: string;
  modelName: string;
  clientOptions: ClientOptions;
  isCua: boolean;
} {
  const modelString = extractModelName(model)!;
  const clientOptions =
    typeof model === "string"
      ? {}
      : (() => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { modelName: _, ...rest } = model;
          return rest;
        })();

  // Check if provider is explicitly set in clientOptions
  const hasExplicitProvider = clientOptions.provider !== undefined;

  // Preserve provider-qualified model IDs (e.g. "moonshotai/kimi-k2.5") so
  // downstream CUA clients can send the exact identifier to OpenRouter.
  let provider: string;
  let parsedModelName: string;

  if (hasExplicitProvider) {
    provider = clientOptions.provider as string;
    parsedModelName = modelString; // Keep the full model name
  } else {
    // Parse provider for metadata only; keep full model id for execution.
    const split = splitModelName(modelString);
    provider = split.provider;
    parsedModelName = modelString;
  }

  // Check if it's a CUA model
  const isCua = true;

  return {
    provider,
    modelName: parsedModelName,
    clientOptions,
    isCua,
  };
}
