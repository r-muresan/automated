import { tool } from "ai";
import { z } from "zod";
import type { V3 } from "../../v3.js";
import type { Action } from "../../types/public/methods.js";
import {
  isMoonshotModel,
  processCoordinates,
} from "../utils/coordinateNormalization.js";
import { ensureXPath } from "../utils/xpath.js";

export const clickAndHoldTool = (v3: V3, provider?: string, modelId?: string) =>
  {
    const unitScaleCoordinates = isMoonshotModel(modelId);
    const coordinateSchema = unitScaleCoordinates
      ? z.number().min(0).max(1)
      : z.number();
    const coordinateDescription = unitScaleCoordinates
      ? "The (x, y) coordinates to click on, normalized to 0..1"
      : "The (x, y) coordinates to click on";

    return tool({
    description: "Click and hold on an element using its coordinates",
    inputSchema: z.object({
      describe: z
        .string()
        .describe(
          "Describe the element to click on in a short, specific phrase that mentions the element type and a good visual description",
        ),
      duration: z
        .number()
        .describe("The duration to hold the element in milliseconds"),
      coordinates: z
        .array(coordinateSchema)
        .describe(coordinateDescription),
    }),
    execute: async ({ describe, coordinates, duration }) => {
      try {
        const page = await v3.context.awaitActivePage();
        const processed = await processCoordinates(
          coordinates[0],
          coordinates[1],
          provider,
          v3,
          modelId,
          page,
        );

        v3.logger({
          category: "agent",
          message: `Agent calling tool: clickAndHold`,
          level: 1,
          auxiliary: {
            arguments: {
              value: JSON.stringify({
                describe,
                duration,
              }),
              type: "object",
            },
          },
        });

        const screenController = v3.getScreenController();
        const shouldCollectXpath =
          !screenController && v3.isAgentReplayActive();

        const [xpath] = screenController
          ? [undefined]
          : await page.dragAndDrop(
              processed.x,
              processed.y,
              processed.x,
              processed.y,
              { delay: duration, returnXpath: shouldCollectXpath },
            );

        if (screenController) {
          await screenController.drag(
            processed.x,
            processed.y,
            processed.x,
            processed.y,
            { holdDelayMs: duration, delayMs: 0, steps: 1 },
          );
          await v3.syncActivePageFromFocus();
        }

        // Record as "act" step with proper Action for deterministic replay (only when caching)
        if (shouldCollectXpath) {
          const normalizedXpath = ensureXPath(xpath);
          if (normalizedXpath) {
            const action: Action = {
              selector: normalizedXpath,
              description: describe,
              method: "clickAndHold",
              arguments: [String(duration)],
            };
            v3.recordAgentReplayStep({
              type: "act",
              instruction: describe,
              actions: [action],
              actionDescription: describe,
            });
          }
        }

        return { success: true, describe };
      } catch (error) {
        return {
          success: false,
          error: `Error clicking and holding: ${(error as Error).message}`,
        };
      }
    },
  });
};
