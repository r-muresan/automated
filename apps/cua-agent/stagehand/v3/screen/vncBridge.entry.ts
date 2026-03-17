// @ts-nocheck
import RFB from "@novnc/novnc/lib/rfb.js";
import keysyms from "@novnc/novnc/lib/input/keysym.js";
import keysymsFromUnicode from "@novnc/novnc/lib/input/keysymdef.js";

const BRIDGE_ID = "__stagehand_vnc_bridge_root__";
const BUTTON_MASKS = {
  left: 1,
  middle: 2,
  right: 4,
};
const WHEEL_MASKS = {
  up: 1 << 3,
  down: 1 << 4,
  left: 1 << 5,
  right: 1 << 6,
};
const SPECIAL_KEYS = new Map([
  ["Alt", { keysym: keysyms.XK_Alt_L, code: "AltLeft", modifier: true }],
  ["ArrowDown", { keysym: keysyms.XK_Down, code: "ArrowDown" }],
  ["ArrowLeft", { keysym: keysyms.XK_Left, code: "ArrowLeft" }],
  ["ArrowRight", { keysym: keysyms.XK_Right, code: "ArrowRight" }],
  ["ArrowUp", { keysym: keysyms.XK_Up, code: "ArrowUp" }],
  ["Backspace", { keysym: keysyms.XK_BackSpace, code: "Backspace" }],
  ["Delete", { keysym: keysyms.XK_Delete, code: "Delete" }],
  ["End", { keysym: keysyms.XK_End, code: "End" }],
  ["Enter", { keysym: keysyms.XK_Return, code: "Enter" }],
  ["Escape", { keysym: keysyms.XK_Escape, code: "Escape" }],
  ["Home", { keysym: keysyms.XK_Home, code: "Home" }],
  ["Meta", { keysym: keysyms.XK_Super_L, code: "MetaLeft", modifier: true }],
  ["PageDown", { keysym: keysyms.XK_Page_Down, code: "PageDown" }],
  ["PageUp", { keysym: keysyms.XK_Page_Up, code: "PageUp" }],
  ["Shift", { keysym: keysyms.XK_Shift_L, code: "ShiftLeft", modifier: true }],
  ["Space", { keysym: keysyms.XK_space, code: "Space" }],
  ["Tab", { keysym: keysyms.XK_Tab, code: "Tab" }],
  ["Control", {
    keysym: keysyms.XK_Control_L,
    code: "ControlLeft",
    modifier: true,
  }],
]);

for (let index = 1; index <= 12; index += 1) {
  SPECIAL_KEYS.set(`F${index}`, {
    keysym: keysyms[`XK_F${index}`],
    code: `F${index}`,
  });
}

let rfb = null;
let connectPromise = null;

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeCoordinate(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function ensureBridgeRoot() {
  let root = document.getElementById(BRIDGE_ID);
  if (root) {
    return root;
  }

  root = document.createElement("div");
  root.id = BRIDGE_ID;
  root.style.position = "fixed";
  root.style.left = "0";
  root.style.top = "0";
  root.style.width = "100vw";
  root.style.height = "100vh";
  root.style.overflow = "hidden";
  root.style.pointerEvents = "none";
  root.style.opacity = "0";
  document.body.append(root);
  return root;
}

function parseVncConnection(value) {
  const parsed = new URL(value);
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

function getMimeType(type) {
  return type === "jpeg" ? "image/jpeg" : "image/png";
}

function getRfb() {
  if (!rfb) {
    throw new Error("VNC bridge is not connected.");
  }
  return rfb;
}

function getButtonMask(button) {
  return BUTTON_MASKS[button] ?? BUTTON_MASKS.left;
}

function currentScreenSize() {
  const client = getRfb();
  const canvas = client._canvas;
  return {
    width: Math.max(
      1,
      Math.round(client._fbWidth || canvas?.width || client._screen?.width || 0),
    ),
    height: Math.max(
      1,
      Math.round(
        client._fbHeight || canvas?.height || client._screen?.height || 0,
      ),
    ),
  };
}

async function waitForFrameBuffer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { width, height } = currentScreenSize();
    if (width > 1 && height > 1) {
      return { width, height };
    }
    await wait(50);
  }
  throw new Error("Timed out waiting for VNC framebuffer dimensions.");
}

function movePointer(x, y) {
  const client = getRfb();
  client._handleMouseMove(normalizeCoordinate(x), normalizeCoordinate(y));
}

function pressPointer(x, y, button) {
  const client = getRfb();
  client._handleMouseButton(
    normalizeCoordinate(x),
    normalizeCoordinate(y),
    getButtonMask(button),
  );
}

function releasePointer(x, y) {
  const client = getRfb();
  client._handleMouseButton(normalizeCoordinate(x), normalizeCoordinate(y), 0);
}

function tapWheel(x, y, mask) {
  const client = getRfb();
  client._handleMouseButton(normalizeCoordinate(x), normalizeCoordinate(y), mask);
  client._handleMouseButton(normalizeCoordinate(x), normalizeCoordinate(y), 0);
}

function normalizeKeyName(raw) {
  const value = String(raw ?? "");
  if (value === " ") return "Space";
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const upper = trimmed.toUpperCase();
  if (upper === "CTRL") return "Control";
  if (upper === "CONTROLORMETA") return "Control";
  if (upper === "CMD" || upper === "COMMAND") return "Meta";
  if (upper === "OPTION") return "Alt";
  if (upper === "SPACE") return "Space";
  if (upper === "ESC") return "Escape";
  if (upper === "RETURN") return "Enter";
  if (upper === "DEL") return "Delete";
  if (upper === "PGUP") return "PageUp";
  if (upper === "PGDN") return "PageDown";
  if (upper.startsWith("ARROW")) {
    return `Arrow${upper.slice(5, 6)}${upper.slice(6).toLowerCase()}`;
  }
  if (trimmed.length === 1) return trimmed;
  return `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1)}`;
}

function guessCodeForCharacter(character) {
  if (/^[a-z]$/i.test(character)) return `Key${character.toUpperCase()}`;
  if (/^[0-9]$/.test(character)) return `Digit${character}`;
  if (character === " ") return "Space";
  return undefined;
}

function resolveKey(raw) {
  const normalized = normalizeKeyName(raw);
  const special = SPECIAL_KEYS.get(normalized);
  if (special) return special;
  if (!normalized) {
    throw new Error("Invalid key value.");
  }

  const codePoint = normalized.codePointAt(0);
  if (normalized.length === 1 && codePoint) {
    const resolvedKeysym = keysymsFromUnicode.lookup(codePoint);
    if (resolvedKeysym !== undefined) {
      return {
        keysym: resolvedKeysym,
        code: guessCodeForCharacter(normalized),
        modifier: false,
      };
    }
  }

  throw new Error(`Unsupported key "${raw}".`);
}

async function sendResolvedKey(client, resolved, down) {
  client.sendKey(resolved.keysym, resolved.code, down);
  await wait(5);
}

async function connect(vncUrl) {
  await dispose();

  const { connectUrl, credentials } = parseVncConnection(vncUrl);
  const root = ensureBridgeRoot();

  connectPromise = new Promise((resolve, reject) => {
    const client = new RFB(root, connectUrl);
    rfb = client;
    client.viewOnly = false;
    client.scaleViewport = false;
    client.clipViewport = false;
    client.resizeSession = false;
    client.showDotCursor = true;
    client.background = "#000";

    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    client.addEventListener("connect", () => {
      resolveOnce();
    });
    client.addEventListener("disconnect", (event) => {
      const clean = Boolean(event?.detail?.clean);
      const message = clean
        ? "VNC bridge disconnected."
        : `VNC bridge disconnected: ${event?.detail?.reason ?? "unknown error"}`;
      if (!settled) {
        rejectOnce(new Error(message));
      }
    });
    client.addEventListener("credentialsrequired", () => {
      if (credentials) {
        client.sendCredentials(credentials);
        return;
      }
      rejectOnce(
        new Error(
          "VNC authentication required. Include username and/or password in the VNC URL query string.",
        ),
      );
    });
    client.addEventListener("securityfailure", (event) => {
      rejectOnce(
        new Error(
          `VNC security failure: ${event?.detail?.reason ?? "authentication failed"}`,
        ),
      );
    });
  });

  await connectPromise;
  await waitForFrameBuffer();
}

async function waitUntilReady() {
  if (!connectPromise) {
    throw new Error("VNC bridge has not started connecting.");
  }
  await connectPromise;
  return await waitForFrameBuffer();
}

async function captureScreenshot(type = "png", quality) {
  const client = getRfb();
  await waitForFrameBuffer();
  const normalizedQuality =
    typeof quality === "number" ? (quality > 1 ? quality / 100 : quality) : undefined;
  return client.toDataURL(getMimeType(type), normalizedQuality);
}

async function mouseMove(x, y) {
  movePointer(x, y);
}

async function mouseDown(x, y, button = "left") {
  movePointer(x, y);
  pressPointer(x, y, button);
}

async function mouseUp(x, y) {
  releasePointer(x, y);
}

async function click(x, y, options = {}) {
  const clickCount = Math.max(1, Math.round(options.clickCount ?? 1));
  const delayMs = Math.max(0, Math.round(options.delayMs ?? 30));
  const button = options.button ?? "left";
  movePointer(x, y);
  for (let index = 0; index < clickCount; index += 1) {
    pressPointer(x, y, button);
    await wait(Math.max(10, delayMs));
    releasePointer(x, y);
    if (index < clickCount - 1) {
      await wait(Math.max(20, delayMs));
    }
  }
}

async function doubleClick(x, y, options = {}) {
  await click(x, y, {
    ...options,
    clickCount: 2,
  });
}

async function scroll(x, y, deltaX = 0, deltaY = 0) {
  movePointer(x, y);
  const horizontalSteps = Math.max(0, Math.round(Math.abs(deltaX) / 120));
  const verticalSteps = Math.max(0, Math.round(Math.abs(deltaY) / 120));

  for (let step = 0; step < verticalSteps; step += 1) {
    tapWheel(x, y, deltaY < 0 ? WHEEL_MASKS.up : WHEEL_MASKS.down);
    await wait(8);
  }

  for (let step = 0; step < horizontalSteps; step += 1) {
    tapWheel(x, y, deltaX < 0 ? WHEEL_MASKS.left : WHEEL_MASKS.right);
    await wait(8);
  }
}

async function drag({
  startX,
  startY,
  endX,
  endY,
  steps = 12,
  delayMs = 12,
  holdDelayMs = 0,
}) {
  const totalSteps = Math.max(1, Math.round(steps));
  movePointer(startX, startY);
  pressPointer(startX, startY, "left");

  if (holdDelayMs > 0) {
    await wait(holdDelayMs);
  }

  for (let index = 1; index <= totalSteps; index += 1) {
    const progress = index / totalSteps;
    const x = startX + (endX - startX) * progress;
    const y = startY + (endY - startY) * progress;
    movePointer(x, y);
    if (delayMs > 0) {
      await wait(delayMs);
    }
  }

  releasePointer(endX, endY);
}

async function sendKeyCombo(combo) {
  const client = getRfb();
  const parts = String(combo ?? "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("Key combo cannot be empty.");
  }

  const resolvedParts = parts.map(resolveKey);
  const modifiers = resolvedParts.filter((part) => part.modifier);
  const primaryParts = resolvedParts.filter((part) => !part.modifier);
  const sequence = primaryParts.length > 0 ? primaryParts : modifiers.slice(-1);
  const heldModifiers =
    primaryParts.length > 0 ? modifiers : modifiers.slice(0, Math.max(0, modifiers.length - 1));

  for (const modifier of heldModifiers) {
    await sendResolvedKey(client, modifier, true);
  }

  for (const part of sequence) {
    await sendResolvedKey(client, part, true);
    await sendResolvedKey(client, part, false);
  }

  for (const modifier of [...heldModifiers].reverse()) {
    await sendResolvedKey(client, modifier, false);
  }
}

async function typeText(text) {
  const client = getRfb();
  for (const character of Array.from(String(text ?? ""))) {
    if (character === "\n" || character === "\r") {
      const enter = resolveKey("Enter");
      await sendResolvedKey(client, enter, true);
      await sendResolvedKey(client, enter, false);
      continue;
    }

    const resolved = resolveKey(character);
    await sendResolvedKey(client, resolved, true);
    await sendResolvedKey(client, resolved, false);
  }
}

async function dispose() {
  if (rfb) {
    try {
      rfb.disconnect();
    } catch {
      // Best effort cleanup only.
    }
  }
  rfb = null;
  connectPromise = null;
  document.getElementById(BRIDGE_ID)?.remove();
}

window.__stagehandVncBridge = {
  connect,
  waitUntilReady,
  getScreenSize: async () => currentScreenSize(),
  captureScreenshot,
  mouseMove,
  mouseDown,
  mouseUp,
  click,
  doubleClick,
  scroll,
  drag,
  sendKeyCombo,
  typeText,
  dispose,
};
