import test from "node:test";
import assert from "node:assert/strict";
import { processCoordinates } from "./coordinateNormalization";

test("processCoordinates scales google coordinates against the VNC screen size", async () => {
  const result = await processCoordinates(
    500,
    250,
    "google",
    {
      isScreenModeEnabled: true,
      getScreenSize: async () => ({ width: 1200, height: 800 }),
      isAdvancedStealth: false,
      configuredViewport: { width: 1000, height: 700 },
    } as any,
  );

  assert.deepEqual(result, { x: 600, y: 200 });
});

test("processCoordinates scales moonshot unit coordinates against the VNC screen size", async () => {
  const result = await processCoordinates(
    0.5,
    0.25,
    undefined,
    {
      isScreenModeEnabled: true,
      getScreenSize: async () => ({ width: 1200, height: 800 }),
      isAdvancedStealth: false,
      configuredViewport: { width: 1000, height: 700 },
    } as any,
    "moonshot-v1",
  );

  assert.deepEqual(result, { x: 600, y: 200 });
});
