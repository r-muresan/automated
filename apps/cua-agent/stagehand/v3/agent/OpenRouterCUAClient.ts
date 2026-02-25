import OpenAI from "openai";
import { ToolSet } from "ai";
import { toJsonSchema } from "../zodCompat.js";
import { AgentClient } from "./AgentClient.js";
import type {
  AgentAction,
  AgentExecutionOptions,
  AgentResult,
  AgentType,
} from "../types/public/agent.js";
import type { ClientOptions } from "../types/public/model.js";

type OpenRouterTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export class OpenRouterCUAClient extends AgentClient {
  private apiKey: string;
  private baseURL: string;
  private client: OpenAI;
  private currentViewport = { width: 1288, height: 711 };
  private currentUrl?: string;
  private screenshotProvider?: () => Promise<string>;
  private actionHandler?: (action: AgentAction) => Promise<void>;
  private tools?: ToolSet;
  private providerOptions?: Record<string, unknown>;
  private reasoningOptions?: Record<string, unknown>;
  private lastScreenshotBase64?: string;

  constructor(
    type: AgentType,
    modelName: string,
    userProvidedInstructions?: string,
    clientOptions?: ClientOptions,
    tools?: ToolSet,
  ) {
    super(type, modelName, userProvidedInstructions);

    this.apiKey =
      (clientOptions?.apiKey as string) ||
      process.env.OPENROUTER_API_KEY ||
      "";
    this.baseURL =
      (clientOptions?.baseURL as string) ||
      process.env.OPENROUTER_BASE_URL ||
      "https://openrouter.ai/api/v1";

    const maybeProvider = (clientOptions as Record<string, unknown> | undefined)
      ?.provider;
    if (maybeProvider && typeof maybeProvider === "object") {
      this.providerOptions = maybeProvider as Record<string, unknown>;
    }

    const maybeReasoning = (clientOptions as Record<string, unknown> | undefined)
      ?.reasoning;
    if (maybeReasoning && typeof maybeReasoning === "object") {
      this.reasoningOptions = maybeReasoning as Record<string, unknown>;
    }

    const defaultHeaders: Record<string, string> = {};
    if (process.env.OPENROUTER_SITE_URL) {
      defaultHeaders["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    }
    if (process.env.OPENROUTER_APP_NAME) {
      defaultHeaders["X-Title"] = process.env.OPENROUTER_APP_NAME;
    }

    this.clientOptions = {
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    };
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      defaultHeaders,
    });
    this.tools = tools;
  }

  setViewport(width: number, height: number): void {
    this.currentViewport = { width, height };
  }

  setCurrentUrl(url: string): void {
    this.currentUrl = url;
  }

  setScreenshotProvider(provider: () => Promise<string>): void {
    this.screenshotProvider = provider;
  }

  setActionHandler(handler: (action: AgentAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  async captureScreenshot(options?: Record<string, unknown>): Promise<unknown> {
    const currentUrl = options?.currentUrl;
    if (typeof currentUrl === "string") {
      this.currentUrl = currentUrl;
    }

    const base64Image = options?.base64Image;
    if (typeof base64Image === "string" && base64Image.length > 0) {
      this.lastScreenshotBase64 = base64Image;
      return `data:image/png;base64,${base64Image}`;
    }

    if (!this.screenshotProvider) return "";
    const screenshot = await this.screenshotProvider();
    this.lastScreenshotBase64 = screenshot;
    return `data:image/png;base64,${screenshot}`;
  }

  private normalizeCoordinates(x: number, y: number): { x: number; y: number } {
    const unitScaleModels: Record<string, boolean> = {
      "moonshotai/kimi-k2.5": true,
    };

    if (unitScaleModels[this.modelName]) {
      return {
        x: Math.floor(Math.min(1, Math.max(0, x)) * this.currentViewport.width),
        y: Math.floor(Math.min(1, Math.max(0, y)) * this.currentViewport.height),
      };
    }

    const clampedX = Math.min(999, Math.max(0, x));
    const clampedY = Math.min(999, Math.max(0, y));
    return {
      x: Math.floor((clampedX / 1000) * this.currentViewport.width),
      y: Math.floor((clampedY / 1000) * this.currentViewport.height),
    };
  }

  private getCuaTools(): OpenRouterTool[] {
    const cuaTools: OpenRouterTool[] = [
      {
        type: "function",
        function: {
          name: "click",
          description: "Click at (x, y) on the screen.",
          parameters: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right", "middle"] },
            },
            required: ["x", "y"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "double_click",
          description: "Double click at (x, y).",
          parameters: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "type",
          description: "Type text into the currently focused element.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "keypress",
          description: "Press keyboard keys. Example: ['Enter']",
          parameters: {
            type: "object",
            properties: { keys: { type: "array", items: { type: "string" } } },
            required: ["keys"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "scroll",
          description:
            "Scroll at position (x, y). Positive scroll_y scrolls down, negative scrolls up.",
          parameters: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              scroll_x: { type: "number" },
              scroll_y: { type: "number" },
            },
            required: ["x", "y", "scroll_y"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "move",
          description: "Move the mouse to (x, y).",
          parameters: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "goto",
          description: "Navigate browser to URL.",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "done",
          description: "Signal task completion.",
          parameters: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
            required: ["success", "message"],
          },
        },
      },
    ];

    if (this.tools) {
      for (const [name, tool] of Object.entries(this.tools)) {
        if (!tool || !tool.description || !tool.inputSchema) continue;
        try {
          cuaTools.push({
            type: "function",
            function: {
              name,
              description: tool.description,
              parameters: toJsonSchema(tool.inputSchema as never),
            },
          });
        } catch {
          // Skip invalid schema for custom tool
        }
      }
    }

    return cuaTools;
  }

  async execute(executionOptions: AgentExecutionOptions): Promise<AgentResult> {
    const { options, logger } = executionOptions;
    const { instruction } = options;
    const maxSteps = options.maxSteps || 10;

    if (!this.screenshotProvider) {
      throw new Error("Screenshot provider is not set");
    }
    if (!this.actionHandler) {
      throw new Error("Action handler is not set");
    }

    let completed = false;
    let currentStep = 0;
    const actions: AgentAction[] = [];
    let finalMessage = "";

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    const logUsageAfterToolCall = (toolName: string) => {
      logger({
        category: "agent",
        message:
          `Usage after tool call "${toolName}": ` +
          `input_tokens=${totalInputTokens}, ` +
          `cached_input_tokens=${totalCachedTokens}, ` +
          `output_tokens=${totalOutputTokens}`,
        level: 1,
      });
    };

    const messages: Array<Record<string, unknown>> = [];
    const systemPrompt =
      this.userProvidedInstructions ||
      "You are a computer use agent controlling a web browser. Use tools and call done() when finished.";
    messages.push({ role: "system", content: systemPrompt });

    try {
      const initialScreenshot = await this.screenshotProvider();
      const viewport = this.currentViewport;
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Viewport: ${viewport.width}x${viewport.height}. URL: ${this.currentUrl || "unknown"}\n\n` +
              `Task: ${instruction}`,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${initialScreenshot}`,
              detail: "high",
            },
          },
        ],
      });

      while (!completed && currentStep < maxSteps) {
        const requestBody: Record<string, unknown> = {
          model: this.modelName,
          messages,
          tools: this.getCuaTools(),
          tool_choice: "auto",
          max_tokens: 4096,
        };
        if (this.providerOptions) {
          requestBody.provider = this.providerOptions;
        }
        if (this.reasoningOptions) {
          requestBody.reasoning = this.reasoningOptions;
        }

        const response = await this.client.chat.completions.create(
          requestBody as never,
        );
        const stepIn = response.usage?.prompt_tokens ?? 0;
        const stepOut = response.usage?.completion_tokens ?? 0;
        const stepCached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        totalInputTokens += stepIn;
        totalOutputTokens += stepOut;
        totalCachedTokens += stepCached;

        const choice = response.choices[0];
        const assistantMessage = choice?.message;
        if (!assistantMessage) {
          break;
        }

        messages.push(assistantMessage as unknown as Record<string, unknown>);

        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          finalMessage =
            (typeof assistantMessage.content === "string"
              ? assistantMessage.content
              : "") || "Task completed";
          completed = true;
          break;
        }

        const toolResults: Array<Record<string, unknown>> = [];
        let doneSignaled = false;

        for (const toolCall of assistantMessage.tool_calls) {
          if (!("function" in toolCall)) {
            continue;
          }
          const toolName = toolCall.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            args = {};
          }

          if (toolName === "done") {
            doneSignaled = true;
            finalMessage = String(args.message ?? "Task completed");
            toolResults.push({
              tool_call_id: toolCall.id,
              role: "tool",
              content: JSON.stringify({ success: true }),
            });
            logUsageAfterToolCall(toolName);
            continue;
          }

          if (this.tools && toolName in this.tools) {
            try {
              const tool = this.tools[toolName];
              const result = await tool.execute?.(args, {
                toolCallId: toolCall.id,
                messages: [],
              });
              toolResults.push({
                tool_call_id: toolCall.id,
                role: "tool",
                content: JSON.stringify(result ?? { success: true }),
              });
            } catch (error) {
              toolResults.push({
                tool_call_id: toolCall.id,
                role: "tool",
                content: JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                }),
              });
            }
            logUsageAfterToolCall(toolName);
            continue;
          }

          let action: AgentAction | null = null;
          if (toolName === "click") {
            const { x, y } = this.normalizeCoordinates(
              Number(args.x ?? 0),
              Number(args.y ?? 0),
            );
            action = {
              type: "click",
              x,
              y,
              button: String(args.button ?? "left"),
            };
          } else if (toolName === "double_click") {
            const { x, y } = this.normalizeCoordinates(
              Number(args.x ?? 0),
              Number(args.y ?? 0),
            );
            action = { type: "double_click", x, y };
          } else if (toolName === "type") {
            action = { type: "type", text: String(args.text ?? "") };
          } else if (toolName === "keypress") {
            action = {
              type: "keypress",
              keys: Array.isArray(args.keys)
                ? (args.keys as unknown[]).map((k) => String(k))
                : [],
            };
          } else if (toolName === "scroll") {
            const { x, y } = this.normalizeCoordinates(
              Number(args.x ?? 0),
              Number(args.y ?? 0),
            );
            action = {
              type: "scroll",
              x,
              y,
              scroll_x: Number(args.scroll_x ?? 0),
              scroll_y: Number(args.scroll_y ?? 0),
            };
          } else if (toolName === "move") {
            const { x, y } = this.normalizeCoordinates(
              Number(args.x ?? 0),
              Number(args.y ?? 0),
            );
            action = { type: "move", x, y };
          } else if (toolName === "goto") {
            action = { type: "goto", url: String(args.url ?? "") };
          }

          if (!action) {
            toolResults.push({
              tool_call_id: toolCall.id,
              role: "tool",
              content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
            });
            logUsageAfterToolCall(toolName);
            continue;
          }

          try {
            actions.push(action);
            this.lastScreenshotBase64 = undefined;
            await this.actionHandler(action);
            toolResults.push({
              tool_call_id: toolCall.id,
              role: "tool",
              content: `Action ${toolName} executed successfully.`,
            });
          } catch (error) {
            toolResults.push({
              tool_call_id: toolCall.id,
              role: "tool",
              content: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            });
          }
          logUsageAfterToolCall(toolName);
        }

        if (toolResults.length > 0) {
          messages.push(...toolResults);
          if (!doneSignaled) {
            const screenshot =
              this.lastScreenshotBase64 || (await this.screenshotProvider());
            messages.push({
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${screenshot}`,
                    detail: "high",
                  },
                },
              ],
            });
          }
        }

        if (doneSignaled) {
          completed = true;
          break;
        }
        currentStep += 1;
      }

      return {
        success: completed,
        actions,
        message: finalMessage || (completed ? "Done" : "Max steps reached"),
        completed,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          cached_input_tokens: totalCachedTokens,
          inference_time_ms: 0,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        actions,
        message: `Failed: ${errorMessage}`,
        completed: false,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          cached_input_tokens: totalCachedTokens,
          inference_time_ms: 0,
        },
      };
    }
  }
}
