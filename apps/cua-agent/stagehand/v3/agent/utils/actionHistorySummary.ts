import type { ModelMessage } from "ai";

interface ExtractedAction {
  toolName: string;
  args: Record<string, unknown>;
  reasoning: string | null;
  stepIndex: number;
}

/**
 * Extract a list of actions taken from the conversation messages.
 * Looks at assistant messages for tool calls and reasoning text.
 */
function extractActionsFromMessages(
  messages: ModelMessage[],
): ExtractedAction[] {
  const actions: ExtractedAction[] = [];
  let stepIndex = 0;

  for (const message of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { role?: string }).role !== "assistant"
    ) {
      continue;
    }

    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    // Extract reasoning text from this assistant message
    let reasoning: string | null = null;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text"
      ) {
        const text = (part as { text?: string }).text;
        if (text && text.trim()) {
          reasoning = text.trim();
        }
      }
    }

    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "tool-call"
      ) {
        const toolCall = part as {
          toolName?: string;
          args?: Record<string, unknown>;
        };
        if (toolCall.toolName) {
          actions.push({
            toolName: toolCall.toolName,
            args: toolCall.args ?? {},
            reasoning,
            stepIndex,
          });
        }
      }
    }
    stepIndex++;
  }

  return actions;
}

/**
 * Summarize an action into a short human-readable string.
 */
function summarizeAction(action: ExtractedAction): string {
  const { toolName, args } = action;

  switch (toolName) {
    case "scroll": {
      const direction = args.direction || "down";
      const percentage = args.percentage || 80;
      const text = args.text ? ` (looking for: "${args.text}")` : "";
      return `scroll ${direction} ${percentage}%${text}`;
    }
    case "click":
      return `click${args.text ? ` on "${args.text}"` : ""}${args.coordinates ? ` at [${args.coordinates}]` : ""}`;
    case "type":
      return `type "${String(args.text || args.value || "").slice(0, 30)}"`;
    case "act":
      return `act: ${String(args.action || "").slice(0, 60)}`;
    case "screenshot":
      return "screenshot";
    case "ariaTree":
      return "ariaTree";
    case "goto":
      return `goto ${String(args.url || "").slice(0, 60)}`;
    case "navback":
      return "navigate back";
    case "wait":
      return `wait ${args.milliseconds || ""}ms`;
    case "extract":
      return `extract data`;
    case "keys":
      return `press key "${args.key || ""}"`;
    case "think":
      return `think`;
    case "done":
      return `done`;
    case "fillForm":
    case "fillFormVision":
      return `fill form`;
    case "dragAndDrop":
      return `drag and drop`;
    default:
      return toolName;
  }
}

/**
 * Detect if there's a repeating loop pattern in the action sequence.
 * Returns the detected loop pattern and how many times it repeated, or null.
 */
function detectLoop(
  actions: ExtractedAction[],
): { pattern: string[]; repetitions: number } | null {
  // Only look at action tool names (not screenshot/ariaTree/think which are observational)
  const actionToolNames = actions
    .filter(
      (a) =>
        !["screenshot", "ariaTree", "think", "done"].includes(a.toolName),
    )
    .map((a) => summarizeAction(a));

  if (actionToolNames.length < 4) return null;

  // Check for repeating patterns of length 2-6
  for (let patternLen = 2; patternLen <= 6; patternLen++) {
    if (actionToolNames.length < patternLen * 2) continue;

    // Check from the end of the sequence
    const lastPattern = actionToolNames.slice(-patternLen);
    let repetitions = 1;

    for (
      let i = actionToolNames.length - patternLen * 2;
      i >= 0;
      i -= patternLen
    ) {
      const segment = actionToolNames.slice(i, i + patternLen);
      if (segment.length < patternLen) break;

      const matches = segment.every((action, idx) => {
        // Fuzzy match: same action type is enough
        return action === lastPattern[idx];
      });

      if (matches) {
        repetitions++;
      } else {
        break;
      }
    }

    if (repetitions >= 2) {
      return { pattern: lastPattern, repetitions };
    }
  }

  return null;
}

/**
 * Build an action history summary and inject it into the messages array.
 * This gives the model awareness of ALL actions it has taken,
 * even when old screenshots have been compressed.
 *
 * Also detects action loops and adds a warning if found.
 *
 * @param messages - The messages array to potentially modify in-place
 * @returns Whether a summary was injected
 */
export function injectActionHistorySummary(messages: ModelMessage[]): boolean {
  const actions = extractActionsFromMessages(messages);

  // Only inject after enough actions to matter (3+ non-observational actions)
  const meaningfulActions = actions.filter(
    (a) => !["screenshot", "ariaTree", "think"].includes(a.toolName),
  );
  if (meaningfulActions.length < 3) return false;

  // Build the summary
  const lines: string[] = [];
  lines.push("ACTION HISTORY (all actions you have taken so far):");
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const actionStr = summarizeAction(action);
    if (action.reasoning) {
      // Truncate long reasoning to keep the summary concise
      const shortReasoning =
        action.reasoning.length > 120
          ? action.reasoning.slice(0, 120) + "..."
          : action.reasoning;
      lines.push(`  ${i + 1}. ${actionStr} — "${shortReasoning}"`);
    } else {
      lines.push(`  ${i + 1}. ${actionStr}`);
    }
  }

  // Detect loops
  const loop = detectLoop(actions);
  if (loop) {
    lines.push("");
    lines.push(
      `⚠️ LOOP DETECTED: You have repeated the pattern [${loop.pattern.join(" → ")}] ${loop.repetitions} times.`,
    );
    lines.push(
      "You MUST try a different approach. Do NOT continue the same sequence of actions.",
    );
    lines.push("Consider:");
    lines.push(
      "  - The item you're looking for may not exist on this page",
    );
    lines.push("  - Try using ariaTree to search the full page content");
    lines.push("  - Try navigating to a different page or using search");
    lines.push(
      "  - If you've scrolled through the entire page without finding it, call done with taskComplete=false",
    );
  }

  const summaryText = lines.join("\n");

  // Remove any previous action history summary we injected
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg.role === "user" && typeof msg.content === "string") {
      if (msg.content.startsWith("ACTION HISTORY")) {
        messages.splice(i, 1);
        break;
      }
    }
  }

  // Inject the summary as the last user message (right before the model's next turn)
  messages.push({
    role: "user",
    content: summaryText,
  });

  return true;
}
