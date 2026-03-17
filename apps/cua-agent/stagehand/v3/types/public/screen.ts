export type ScreenCaptureType = "png" | "jpeg";

export interface ScreenCaptureOptions {
  type?: ScreenCaptureType;
  quality?: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ScreenClickOptions {
  button?: "left" | "middle" | "right";
  clickCount?: number;
  delayMs?: number;
}

export interface ScreenDragOptions {
  steps?: number;
  delayMs?: number;
  holdDelayMs?: number;
}

export interface ScreenController {
  connect(): Promise<void>;
  close(): Promise<void>;
  getScreenSize(): Promise<ScreenSize>;
  captureScreenshot(options?: ScreenCaptureOptions): Promise<Buffer>;
  click(x: number, y: number, options?: ScreenClickOptions): Promise<void>;
  move(x: number, y: number): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: ScreenDragOptions,
  ): Promise<void>;
  sendKeys(keys: string | string[]): Promise<void>;
  typeText(text: string): Promise<void>;
}
