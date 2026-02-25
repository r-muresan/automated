/**
 * Start and monitor a workflow execution through backend HTTP endpoints.
 *
 * Usage:
 *   npx tsx scripts/run-workflow.ts <workflow-id>
 *   npx tsx scripts/run-workflow.ts <workflow-id> --api-url http://127.0.0.1:8080/api
 *   npx tsx scripts/run-workflow.ts <workflow-id> --token <bearer-token>
 *   npx tsx scripts/run-workflow.ts <workflow-id> --allow-local
 *   npx tsx scripts/run-workflow.ts <workflow-id> --input Name=Value --input Country=US
 */
import "dotenv/config";

type WorkflowExecutionState = {
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  currentStep: number;
  totalSteps: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  runId?: string;
};

type WorkflowAction = {
  id: string;
  runId: string;
  eventType: string | null;
  message: string;
  timestamp: string;
  data?: Record<string, unknown> | null;
  level?: "info" | "warn" | "error";
};

type CliOptions = {
  workflowId: string;
  apiUrl: string;
  token?: string;
  pollMs: number;
  inputValues: Record<string, string>;
  requireBrowserbase: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function printUsage(): void {
  console.log(
    "Usage: npx tsx scripts/run-workflow.ts <workflow-id> [--api-url http://127.0.0.1:8080/api] [--token <bearer>] [--poll-ms 1500] [--input Name=Value] [--allow-local]",
  );
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const workflowId = args[0];
  if (!workflowId || workflowId.startsWith("--")) {
    printUsage();
    throw new Error("Missing required <workflow-id>.");
  }

  let apiUrl = process.env.RUN_WORKFLOW_API_URL || "http://127.0.0.1:8080/api";
  let token = process.env.RUN_WORKFLOW_TOKEN || process.env.CLERK_BEARER_TOKEN;
  let pollMs = 1500;
  let requireBrowserbase = true;
  const inputValues: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--api-url") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --api-url");
      apiUrl = value;
      i += 1;
      continue;
    }
    if (arg === "--token") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --token");
      token = value;
      i += 1;
      continue;
    }
    if (arg === "--poll-ms") {
      const value = args[i + 1];
      const parsed = Number(value);
      if (!value || Number.isNaN(parsed) || parsed < 250) {
        throw new Error("Invalid --poll-ms value (must be >= 250).");
      }
      pollMs = parsed;
      i += 1;
      continue;
    }
    if (arg === "--input") {
      const kv = args[i + 1];
      if (!kv || kv.startsWith("--") || !kv.includes("=")) {
        throw new Error('Invalid --input. Expected format: --input "Name=Value"');
      }
      const [rawKey, ...rest] = kv.split("=");
      const key = rawKey.trim();
      if (!key) throw new Error("Input key cannot be empty.");
      inputValues[key] = rest.join("=").trim();
      i += 1;
      continue;
    }
    if (arg === "--allow-local") {
      requireBrowserbase = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    workflowId,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    token: token || undefined,
    pollMs,
    inputValues,
    requireBrowserbase,
  };
}

async function http<T>(
  method: "GET" | "POST",
  url: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const maybeJson = text ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        `[401] Unauthorized ${url}\nPass a Clerk bearer token with --token <token> or set RUN_WORKFLOW_TOKEN.`,
      );
    }
    throw new Error(
      `[${response.status}] ${response.statusText} ${url}\n${typeof maybeJson === "string" ? maybeJson : JSON.stringify(maybeJson ?? text)}`,
    );
  }

  return (maybeJson as T) ?? ({} as T);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const base = `${opts.apiUrl}/workflows/${opts.workflowId}`;

  console.log(`[RUNNER] Workflow ID: ${opts.workflowId}`);
  console.log(`[RUNNER] API URL: ${opts.apiUrl}`);
  console.log(`[RUNNER] Poll interval: ${opts.pollMs}ms`);
  console.log(
    `[RUNNER] Provider requirement: ${opts.requireBrowserbase ? "browserbase" : "browserbase-or-local"}`,
  );
  if (Object.keys(opts.inputValues).length > 0) {
    console.log(`[RUNNER] Inputs: ${JSON.stringify(opts.inputValues)}`);
  }

  const startResult = await http<{ success: boolean; message: string }>(
    "POST",
    `${base}/execution/start`,
    opts.token,
    {
      ...(Object.keys(opts.inputValues).length > 0
        ? { inputValues: opts.inputValues }
        : {}),
      requireBrowserbase: opts.requireBrowserbase,
    },
  );
  console.log(`[RUNNER] Start response: success=${startResult.success} message="${startResult.message}"`);
  if (!startResult.success) {
    throw new Error(`Workflow did not start: ${startResult.message}`);
  }

  const printedActionIds = new Set<string>();
  let lastStatus: WorkflowExecutionState | null = null;
  let runId: string | undefined;

  while (true) {
    const status = await http<WorkflowExecutionState>("GET", `${base}/execution/status`, opts.token);
    const statusChanged = !lastStatus || status.status !== lastStatus.status;
    if (statusChanged) {
      console.log(
        `[RUNNER] Status: ${status.status} (step ${status.currentStep}/${status.totalSteps})${status.runId ? ` runId=${status.runId}` : ""}`,
      );
    }
    lastStatus = status;
    runId = runId ?? status.runId;

    if (runId) {
      const actions = await http<WorkflowAction[]>(
        "GET",
        `${base}/execution/actions?runId=${encodeURIComponent(runId)}`,
        opts.token,
      );
      for (const action of actions) {
        if (printedActionIds.has(action.id)) continue;
        printedActionIds.add(action.id);
        const level = action.level ?? "info";
        const eventType = action.eventType ?? "-";
        console.log(
          `[ACTION] ${action.timestamp} [${level}] [${eventType}] ${action.message}${action.data ? ` data=${JSON.stringify(action.data)}` : ""}`,
        );
      }
    }

    if (status.status === "completed") {
      console.log("[RUNNER] Workflow completed.");
      break;
    }
    if (status.status === "failed" || status.status === "stopped") {
      throw new Error(`Workflow ${status.status}: ${status.error ?? "Unknown error"}`);
    }

    await sleep(opts.pollMs);
  }

  if (runId) {
    const output = await http<{ output: string | null; outputExtension: string | null }>(
      "GET",
      `${base}/runs/${encodeURIComponent(runId)}/output`,
      opts.token,
    );
    if (output.output !== null) {
      console.log(
        `[RUNNER] Run output captured. extension=${output.outputExtension ?? "txt"} length=${output.output.length}`,
      );
    } else {
      console.log("[RUNNER] Run output: none");
    }
  }
}

main().catch((error) => {
  console.error("[RUNNER] Error:", error);
  process.exit(1);
});
