import OpenAI from 'openai';
import { v7 as uuidv7 } from 'uuid';
import { SessionFileLogger } from '../stagehand/v3/flowLogger.js';

function logUsage(requestId: string, model: string, operation: string, response: any): void {
  const usage = response?.usage;
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const cachedInputTokens =
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.cache_read_input_tokens ??
    0;

  SessionFileLogger.logLlmResponse({
    requestId,
    model,
    operation,
    inputTokens,
    outputTokens,
    cachedInputTokens,
  });
}

/**
 * Wraps an OpenAI client so that every `chat.completions.create` and
 * `chat.completions.parse` call is automatically tracked by the
 * SessionFileLogger token cost tracker.
 *
 * Uses a Proxy so the original APIPromise return type (with ._thenUnwrap,
 * .withResponse, etc.) is preserved.
 */
export function wrapOpenAIWithTracking(client: OpenAI): OpenAI {
  const completions = client.chat.completions;

  // Re-entrancy guard: when `parse()` internally calls `create()`, the nested
  // call must NOT be intercepted.  Attaching a `.then()` side-effect on the
  // inner `create` APIPromise consumes the Response body before `parse`'s
  // `_thenUnwrap` can read it, causing "Body has already been read".
  let inTrackedCall = false;

  client.chat.completions = new Proxy(completions, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if ((prop === 'create' || prop === 'parse') && typeof original === 'function') {
        return function (this: any, ...args: any[]) {
          // Skip tracking for nested calls (e.g. create() called inside parse())
          if (inTrackedCall) {
            return original.apply(this, args);
          }

          const body = args[0] as Record<string, unknown> | undefined;
          const model = (body?.model as string) || 'unknown';
          const requestId = uuidv7();
          const operation = `orchestrator.${String(prop)}`;

          SessionFileLogger.logLlmRequest({ requestId, model, operation });

          // Set re-entrancy guard before calling original — parse() synchronously
          // calls create() during setup, so the flag prevents double-tracking.
          inTrackedCall = true;
          let result: any;
          try {
            result = original.apply(this, args);
          } finally {
            inTrackedCall = false;
          }

          // Attach a .then side-effect to log the response without altering the return type
          if (result && typeof result.then === 'function') {
            result.then(
              (response: any) => logUsage(requestId, model, operation, response),
              (error: any) => {
                SessionFileLogger.logLlmResponse({
                  requestId,
                  model,
                  operation,
                  output: `[error: ${error instanceof Error ? error.message : 'unknown'}]`,
                });
              },
            );
          }

          return result;
        };
      }
      return original;
    },
  });

  return client;
}
