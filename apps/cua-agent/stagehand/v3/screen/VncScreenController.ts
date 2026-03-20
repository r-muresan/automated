import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "patchright";
import type {
  ScreenCaptureOptions,
  ScreenController,
  ScreenSize,
} from "../types/public/screen.js";
import {
  getCurrentDirPath,
} from "../runtimePaths.js";

const DEFAULT_BRIDGE_VIEWPORT = { width: 1400, height: 1000 };
const CURRENT_DIR_PATH = getCurrentDirPath();

function resolveBridgeEntryPath(): string {
  const candidates = [
    path.join(CURRENT_DIR_PATH, "vncBridge.entry.ts"),
    path.join(CURRENT_DIR_PATH, "vncBridge.entry.js"),
    path.resolve(
      process.cwd(),
      "apps/cua-agent/stagehand/v3/screen/vncBridge.entry.ts",
    ),
    path.resolve(
      process.cwd(),
      "apps/cua-agent/stagehand/v3/screen/vncBridge.entry.js",
    ),
    path.resolve(
      process.cwd(),
      "dist/apps/cua-agent/stagehand/v3/screen/vncBridge.entry.js",
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

const BRIDGE_ENTRY_PATH = resolveBridgeEntryPath();

export interface ParsedVncUrl {
  connectUrl: string;
  credentials: {
    username?: string;
    password?: string;
  } | null;
}

type BridgePageLike = {
  setContent(html: string): Promise<void>;
  evaluate<Result, Arg>(
    pageFunction: (arg: Arg) => Result | Promise<Result>,
    arg?: Arg,
  ): Promise<Result>;
};

type BridgeRuntime = {
  page: BridgePageLike;
  close(): Promise<void>;
};

export interface VncScreenControllerOptions {
  vncUrl: string;
  createBridgeRuntime?: () => Promise<BridgeRuntime>;
  loadBridgeBundle?: () => Promise<string>;
}

export function parseVncUrl(vncUrl: string): ParsedVncUrl {
  const parsed = new URL(vncUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `Unsupported VNC URL protocol: ${parsed.protocol}. Expected ws:// or wss://.`,
    );
  }

  const username = parsed.searchParams.get("username") ?? undefined;
  const password = parsed.searchParams.get("password") ?? undefined;
  parsed.searchParams.delete("username");
  parsed.searchParams.delete("password");

  return {
    connectUrl: parsed.toString(),
    credentials:
      username || password
        ? {
            ...(username ? { username } : {}),
            ...(password ? { password } : {}),
          }
        : null,
  };
}

function normalizeScreenshotQuality(quality?: number): number | undefined {
  if (typeof quality !== "number" || Number.isNaN(quality)) {
    return undefined;
  }
  return quality > 1 ? quality / 100 : quality;
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const match = /^data:.*?;base64,(.+)$/i.exec(dataUrl);
  if (!match?.[1]) {
    throw new Error("Invalid VNC screenshot payload.");
  }
  return Buffer.from(match[1], "base64");
}

function buildBridgeHtml(bundle: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Stagehand VNC Bridge</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
      }
    </style>
  </head>
  <body>
    <script type="module">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
  </body>
</html>`;
}

async function createDefaultBridgeRuntime(): Promise<BridgeRuntime> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const context = await browser.newContext({
    viewport: DEFAULT_BRIDGE_VIEWPORT,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    const text = message.text();
    if (text) {
      console.log(`[VNC bridge console] ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    console.error(`[VNC bridge pageerror] ${error.message}`);
  });
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "stagehand-vnc-bridge-"),
  );
  const htmlPath = path.join(tempDir, "bridge.html");

  return {
    page: {
      async setContent(html: string): Promise<void> {
        await fs.promises.writeFile(htmlPath, html, "utf8");
        await page.goto(pathToFileURL(htmlPath).href, {
          waitUntil: "load",
        });
      },
      async evaluate<Result, Arg>(
        pageFunction: (arg: Arg) => Result | Promise<Result>,
        arg?: Arg,
      ): Promise<Result> {
        return await (page.evaluate as any)(pageFunction, arg);
      },
    },
    async close(): Promise<void> {
      await closePatchrightBridge(browser, context, page);
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function closePatchrightBridge(
  browser: Browser,
  context: BrowserContext,
  page: Page,
): Promise<void> {
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

let bridgeBundlePromise: Promise<string> | null = null;

async function loadDefaultBridgeBundle(): Promise<string> {
  if (!bridgeBundlePromise) {
    bridgeBundlePromise = (async () => {
      const { build } = await import("esbuild");
      const result = await build({
        entryPoints: [BRIDGE_ENTRY_PATH],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "esnext",
        minify: false,
        plugins: [
          {
            name: "patch-novnc-top-level-await",
            setup(b) {
              b.onLoad(
                { filter: /novnc\/lib\/util\/browser\.js$/ },
                async (args) => {
                  let contents = await fs.promises.readFile(
                    args.path,
                    "utf8",
                  );
                  // noVNC's compiled CJS uses top-level await which esbuild
                  // cannot bundle through require(). Wrap it in an async IIFE.
                  contents = contents.replace(
                    /^(exports\.supportsWebCodecsH264Decode\s*=\s*supportsWebCodecsH264Decode\s*=\s*)await\s+(_checkWebCodecsH264DecodeSupport\(\));/m,
                    "$1false; (async () => { try { exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = await $2 } catch {} })();",
                  );
                  return { contents, loader: "js" };
                },
              );
            },
          },
        ],
      });
      return result.outputFiles![0]!.text;
    })();
  }

  return bridgeBundlePromise;
}

export class VncScreenController implements ScreenController {
  private readonly vncUrl: string;
  private readonly createBridgeRuntime: () => Promise<BridgeRuntime>;
  private readonly loadBridgeBundle: () => Promise<string>;
  private bridgeRuntime: BridgeRuntime | null = null;
  private connected = false;

  constructor(options: VncScreenControllerOptions) {
    parseVncUrl(options.vncUrl);
    this.vncUrl = options.vncUrl;
    this.createBridgeRuntime =
      options.createBridgeRuntime ?? createDefaultBridgeRuntime;
    this.loadBridgeBundle = options.loadBridgeBundle ?? loadDefaultBridgeBundle;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const runtime = await this.ensureRuntime();
    await this.invoke<void, string>("connect", this.vncUrl);
    await this.invoke<ScreenSize, undefined>("waitUntilReady", undefined);
    this.connected = true;
    this.bridgeRuntime = runtime;
  }

  async close(): Promise<void> {
    const runtime = this.bridgeRuntime;
    if (!runtime) {
      return;
    }

    await runtime.page
      .evaluate(() => {
        const bridge = (globalThis as unknown as {
          __stagehandVncBridge?: { dispose?: () => Promise<void> | void };
        }).__stagehandVncBridge;
        return bridge?.dispose?.();
      })
      .catch(() => {});
    await runtime.close().catch(() => {});
    this.bridgeRuntime = null;
    this.connected = false;
  }

  async getScreenSize(): Promise<ScreenSize> {
    await this.ensureConnected();
    return await this.invoke<ScreenSize, undefined>("getScreenSize", undefined);
  }

  async captureScreenshot(options?: ScreenCaptureOptions): Promise<Buffer> {
    await this.ensureConnected();
    const dataUrl = await this.invoke<string, { type: string; quality?: number }>(
      "captureScreenshot",
      {
        type: options?.type ?? "png",
        quality: normalizeScreenshotQuality(options?.quality),
      },
    );
    return dataUrlToBuffer(dataUrl);
  }

  async click(
    x: number,
    y: number,
    options?: { button?: "left" | "middle" | "right"; clickCount?: number; delayMs?: number },
  ): Promise<void> {
    await this.ensureConnected();
    await this.invoke<void, { x: number; y: number; options?: typeof options }>(
      "click",
      { x, y, options },
    );
  }

  async move(x: number, y: number): Promise<void> {
    await this.ensureConnected();
    await this.invoke<void, { x: number; y: number }>("mouseMove", { x, y });
  }

  async scroll(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    await this.ensureConnected();
    await this.invoke<void, { x: number; y: number; deltaX: number; deltaY: number }>(
      "scroll",
      { x, y, deltaX, deltaY },
    );
  }

  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: { steps?: number; delayMs?: number; holdDelayMs?: number },
  ): Promise<void> {
    await this.ensureConnected();
    await this.invoke<
      void,
      {
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        steps?: number;
        delayMs?: number;
        holdDelayMs?: number;
      }
    >("drag", {
      startX,
      startY,
      endX,
      endY,
      ...options,
    });
  }

  async sendKeys(keys: string | string[]): Promise<void> {
    await this.ensureConnected();
    const combos = Array.isArray(keys) ? keys : [keys];
    for (const combo of combos) {
      await this.invoke<void, string>(
        "sendKeyCombo",
        combo === " " ? "Space" : combo,
      );
    }
  }

  async typeText(text: string): Promise<void> {
    await this.ensureConnected();
    await this.invoke<void, string>("typeText", text);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private async ensureRuntime(): Promise<BridgeRuntime> {
    if (this.bridgeRuntime) {
      return this.bridgeRuntime;
    }

    const runtime = await this.createBridgeRuntime();
    const bundle = await this.loadBridgeBundle();
    await runtime.page.setContent(buildBridgeHtml(bundle));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const loaded = await runtime.page
        .evaluate(() => {
          const bridge = (globalThis as unknown as {
            __stagehandVncBridge?: { connect?: unknown };
          }).__stagehandVncBridge;
          return typeof bridge?.connect === "function";
        })
        .catch(() => false);
      if (loaded) {
        this.bridgeRuntime = runtime;
        return runtime;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await runtime.close().catch(() => {});
    throw new Error("Timed out waiting for the VNC bridge runtime to load.");
  }

  private async invoke<Result, Arg>(method: string, arg: Arg): Promise<Result> {
    const runtime = await this.ensureRuntime();
    return (await runtime.page.evaluate(
      ({ methodName, payload }) => {
        const bridge = (globalThis as unknown as { __stagehandVncBridge?: Record<string, (...args: any[]) => unknown> })
          .__stagehandVncBridge;
        if (!bridge || typeof bridge[methodName] !== "function") {
          throw new Error(`VNC bridge method "${methodName}" is unavailable.`);
        }

        const payloadRecord =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : undefined;

        if (
          payloadRecord &&
          "options" in payloadRecord &&
          Object.keys(payloadRecord).length === 3
        ) {
          return bridge[methodName](
            payloadRecord.x,
            payloadRecord.y,
            payloadRecord.options,
          );
        }

        if (
          payloadRecord &&
          "deltaX" in payloadRecord &&
          "deltaY" in payloadRecord
        ) {
          return bridge[methodName](
            payloadRecord.x,
            payloadRecord.y,
            payloadRecord.deltaX,
            payloadRecord.deltaY,
          );
        }

        if (
          payloadRecord &&
          "startX" in payloadRecord &&
          "endX" in payloadRecord
        ) {
          return bridge[methodName](payloadRecord);
        }

        if (
          payloadRecord &&
          "x" in payloadRecord &&
          "y" in payloadRecord
        ) {
          return bridge[methodName](payloadRecord.x, payloadRecord.y);
        }

        if (
          payloadRecord &&
          "type" in payloadRecord
        ) {
          return bridge[methodName](payloadRecord.type, payloadRecord.quality);
        }

        return bridge[methodName](payload);
      },
      { methodName: method, payload: arg },
    )) as Result;
  }
}
