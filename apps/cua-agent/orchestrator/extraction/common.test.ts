import test from "node:test";
import assert from "node:assert/strict";
import { capturePageScreenshot } from "./common";

test("capturePageScreenshot uses the screen-backed screenshot path", async () => {
  const screenshot = await capturePageScreenshot({
    assertScreenMode: () => {},
    captureModelScreenshot: async () => Buffer.from("screen-shot"),
  } as any);

  assert.equal(
    screenshot,
    `data:image/jpeg;base64,${Buffer.from("screen-shot").toString("base64")}`,
  );
});

test("capturePageScreenshot surfaces the screen mode requirement", async () => {
  await assert.rejects(
    () =>
      capturePageScreenshot({
        assertScreenMode: () => {
          throw new Error("screen mode required");
        },
      } as any),
    /screen mode required/,
  );
});
