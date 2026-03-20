import type { Hyperbrowser } from "@hyperbrowser/sdk";
import type {
  ScreenCaptureOptions,
  ScreenClickOptions,
  ScreenController,
  ScreenDragOptions,
  ScreenSize,
} from "../types/public/screen.js";

export interface HyperbrowserScreenControllerOptions {
  client: Hyperbrowser;
  sessionId: string;
  /** Screen dimensions — defaults to 1280×720 if not provided. */
  screenSize?: ScreenSize;
}

/**
 * ScreenController implementation backed by the Hyperbrowser Computer Actions
 * API. All interactions go through the SDK's `computerAction` service which
 * sends commands to the remote browser's OS-level input layer, giving us
 * full-browser (not just current-tab) control.
 */
export class HyperbrowserScreenController implements ScreenController {
  private readonly client: Hyperbrowser;
  private readonly sessionId: string;
  private readonly size: ScreenSize;
  private connected = false;

  constructor(options: HyperbrowserScreenControllerOptions) {
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.size = options.screenSize ?? { width: 1280, height: 720 };
  }

  async connect(): Promise<void> {
    // The Hyperbrowser session is already running — just verify we can take a
    // screenshot as a connectivity check.
    const result = await this.client.computerAction.screenshot(this.sessionId);
    if (!result.success) {
      throw new Error(
        `Hyperbrowser computer action connectivity check failed: ${result.error ?? result.message ?? "unknown error"}`,
      );
    }
    this.connected = true;
  }

  async close(): Promise<void> {
    // Nothing to tear down — the session lifecycle is managed elsewhere.
    this.connected = false;
  }

  async getScreenSize(): Promise<ScreenSize> {
    return this.size;
  }

  async captureScreenshot(_options?: ScreenCaptureOptions): Promise<Buffer> {
    const result = await this.client.computerAction.screenshot(this.sessionId);
    if (!result.success || !result.screenshot) {
      throw new Error(
        `Hyperbrowser screenshot failed: ${result.error ?? result.message ?? "no screenshot returned"}`,
      );
    }
    return Buffer.from(result.screenshot, "base64");
  }

  async click(
    x: number,
    y: number,
    options?: ScreenClickOptions,
  ): Promise<void> {
    const button = options?.button ?? "left";
    const numClicks = options?.clickCount ?? 1;
    const result = await this.client.computerAction.click(
      this.sessionId,
      x,
      y,
      button,
      numClicks,
    );
    if (!result.success) {
      throw new Error(
        `Hyperbrowser click failed: ${result.error ?? result.message ?? "unknown error"}`,
      );
    }
  }

  async move(x: number, y: number): Promise<void> {
    const result = await this.client.computerAction.moveMouse(
      this.sessionId,
      x,
      y,
    );
    if (!result.success) {
      throw new Error(
        `Hyperbrowser moveMouse failed: ${result.error ?? result.message ?? "unknown error"}`,
      );
    }
  }

  async scroll(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    const result = await this.client.computerAction.scroll(
      this.sessionId,
      x,
      y,
      deltaX,
      deltaY,
    );
    if (!result.success) {
      throw new Error(
        `Hyperbrowser scroll failed: ${result.error ?? result.message ?? "unknown error"}`,
      );
    }
  }

  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: ScreenDragOptions,
  ): Promise<void> {
    // Build a path of coordinates from start to end. The Hyperbrowser drag API
    // takes an array of waypoints.
    const steps = options?.steps ?? 10;
    const path: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      path.push({
        x: Math.round(startX + (endX - startX) * t),
        y: Math.round(startY + (endY - startY) * t),
      });
    }
    const result = await this.client.computerAction.drag(
      this.sessionId,
      path,
    );
    if (!result.success) {
      throw new Error(
        `Hyperbrowser drag failed: ${result.error ?? result.message ?? "unknown error"}`,
      );
    }
  }

  async sendKeys(keys: string | string[]): Promise<void> {
    const combos = Array.isArray(keys) ? keys : [keys];
    for (const combo of combos) {
      // Convert Playwright-style key combos (e.g. "Control+A") to xdotool
      // format used by Hyperbrowser (e.g. ["Control_L", "a"]).
      const parts = combo.split("+").map((k) => toXdotoolKey(k.trim()));
      const result = await this.client.computerAction.pressKeys(
        this.sessionId,
        parts,
      );
      if (!result.success) {
        throw new Error(
          `Hyperbrowser pressKeys failed: ${result.error ?? result.message ?? "unknown error"}`,
        );
      }
    }
  }

  async typeText(text: string): Promise<void> {
    const result = await this.client.computerAction.typeText(
      this.sessionId,
      text,
    );
    if (!result.success) {
      throw new Error(
        `Hyperbrowser typeText failed: ${result.error ?? result.message ?? "unknown error"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Key mapping — Playwright key names → xdotool key names
// ---------------------------------------------------------------------------

const KEY_MAP: Record<string, string> = {
  // Modifiers
  Control: "Control_L",
  Ctrl: "Control_L",
  Meta: "Control_L",
  Cmd: "Control_L",
  Command: "Control_L",
  Alt: "Alt_L",
  Option: "Alt_L",
  Shift: "Shift_L",

  // Navigation
  Enter: "Return",
  Return: "Return",
  Tab: "Tab",
  Escape: "Escape",
  Esc: "Escape",
  Backspace: "BackSpace",
  Delete: "Delete",
  Space: "space",
  " ": "space",

  // Arrows
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",

  // Function keys
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",

  // Other
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  Insert: "Insert",
};

function toXdotoolKey(key: string): string {
  const mapped = KEY_MAP[key];
  if (mapped) return mapped;

  // Single characters: xdotool expects lowercase keysym names for letters
  // (e.g. "a" not "A"). Uppercase "A" is not a valid xdotool keysym.
  if (key.length === 1) {
    return key.toLowerCase();
  }

  return key;
}
