import test from "node:test";
import assert from "node:assert/strict";
import {
  VncScreenController,
  parseVncUrl,
} from "./VncScreenController";

function createMockRuntime() {
  const calls: Array<[string, ...unknown[]]> = [];
  let closed = false;

  const bridge = {
    connect: async (url: string) => {
      calls.push(["connect", url]);
    },
    waitUntilReady: async () => {
      calls.push(["waitUntilReady"]);
      return { width: 1280, height: 800 };
    },
    getScreenSize: async () => {
      calls.push(["getScreenSize"]);
      return { width: 1280, height: 800 };
    },
    captureScreenshot: async (type: string, quality?: number) => {
      calls.push(["captureScreenshot", type, quality]);
      return `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
    },
    click: async (x: number, y: number, options?: unknown) => {
      calls.push(["click", x, y, options]);
    },
    sendKeyCombo: async (combo: string) => {
      calls.push(["sendKeyCombo", combo]);
    },
    typeText: async (text: string) => {
      calls.push(["typeText", text]);
    },
    dispose: async () => {
      calls.push(["dispose"]);
    },
  };

  const runtime = {
    page: {
      setContent: async (html: string) => {
        calls.push(["setContent", html.includes("Stagehand VNC Bridge")]);
      },
      evaluate: async <Result, Arg>(
        pageFunction: (arg: Arg) => Result | Promise<Result>,
        arg?: Arg,
      ): Promise<Result> => {
        (globalThis as typeof globalThis & {
          __stagehandVncBridge?: typeof bridge;
        }).__stagehandVncBridge = bridge;
        return await pageFunction(arg as Arg);
      },
    },
    close: async () => {
      closed = true;
      calls.push(["closeRuntime"]);
    },
  };

  return {
    bridge,
    calls,
    runtime,
    isClosed: () => closed,
  };
}

test("parseVncUrl strips auth params and preserves provider query params", () => {
  const parsed = parseVncUrl(
    "wss://example.com/websockify?token=abc&username=user&password=secret&foo=bar",
  );

  assert.equal(
    parsed.connectUrl,
    "wss://example.com/websockify?token=abc&foo=bar",
  );
  assert.deepEqual(parsed.credentials, {
    username: "user",
    password: "secret",
  });
});

test("VncScreenController dispatches through the injected bridge runtime", async () => {
  const mock = createMockRuntime();
  const controller = new VncScreenController({
    vncUrl: "wss://example.com/websockify?token=abc",
    createBridgeRuntime: async () => mock.runtime,
    loadBridgeBundle: async () => "globalThis.__stagehandVncBridge = {};",
  });

  await controller.connect();
  assert.deepEqual(await controller.getScreenSize(), { width: 1280, height: 800 });

  const screenshot = await controller.captureScreenshot({ type: "png" });
  assert.equal(screenshot.toString(), "image");

  await controller.click(20, 30, { clickCount: 2 });
  await controller.sendKeys(["Control+L", "Space"]);
  await controller.typeText("hello");
  await controller.close();

  assert.equal(mock.isClosed(), true);
  assert.ok(
    mock.calls.some(([name]) => name === "dispose"),
    "expected dispose to be called",
  );
  assert.ok(
    mock.calls.some(([name, combo]) => name === "sendKeyCombo" && combo === "Space"),
    "expected literal space to be normalized to Space",
  );
});
