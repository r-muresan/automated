import { tool } from "ai";
import { z } from "zod";
import type { V3 } from "../../v3.js";
import type {
  ScrollToolResult,
  ScrollVisionToolResult,
  ModelOutputContentItem,
} from "../../types/public/agent.js";
import {
  isMoonshotModel,
  processCoordinates,
} from "../utils/coordinateNormalization.js";
import { waitAndCaptureScreenshot } from "../utils/screenshotHandler.js";

type ActivePage = Awaited<ReturnType<V3["context"]["awaitActivePage"]>>;

async function getScrollContainerHeightAtPoint(
  page: ActivePage,
  x: number,
  y: number,
): Promise<number> {
  return page.mainFrame().evaluate<number, { x: number; y: number }>(
    ({ x: pointX, y: pointY }) => {
      const viewportHeight = Math.max(
        1,
        Math.round(window.visualViewport?.height ?? window.innerHeight ?? 1),
      );
      const viewportWidth = Math.max(1, window.innerWidth ?? 1);

      const clamp = (value: number, min: number, max: number): number =>
        Math.min(max, Math.max(min, value));
      const isScrollable = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        const canScrollY =
          overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
        return canScrollY && el.scrollHeight > el.clientHeight + 1;
      };
      const findScrollableAncestor = (start: Element | null): Element | null => {
        let current: Element | null = start;
        while (current) {
          if (isScrollable(current)) return current;
          current = current.parentElement;
        }
        return null;
      };

      let localX = clamp(Math.round(pointX), 0, Math.max(0, viewportWidth - 1));
      let localY = clamp(Math.round(pointY), 0, Math.max(0, viewportHeight - 1));
      let currentDoc: Document = document;
      let hit: Element | null = currentDoc.elementFromPoint(localX, localY);

      while (hit instanceof HTMLIFrameElement) {
        const frameRect = hit.getBoundingClientRect();
        const frameHeight = Math.max(1, Math.round(frameRect.height || viewportHeight));

        let nextDoc: Document | null = null;
        try {
          nextDoc = hit.contentDocument;
        } catch {
          nextDoc = null;
        }

        if (!nextDoc) return frameHeight;

        localX = clamp(Math.round(localX - frameRect.left), 0, Math.max(0, frameRect.width - 1));
        localY = clamp(Math.round(localY - frameRect.top), 0, Math.max(0, frameRect.height - 1));
        currentDoc = nextDoc;
        hit = currentDoc.elementFromPoint(localX, localY);
      }

      const scrollContainer = findScrollableAncestor(hit);
      if (scrollContainer) {
        const containerHeight = scrollContainer.clientHeight || scrollContainer.getBoundingClientRect().height;
        return Math.max(1, Math.round(containerHeight || viewportHeight));
      }

      const root = currentDoc.scrollingElement ?? currentDoc.documentElement;
      return Math.max(1, Math.round(root?.clientHeight ?? viewportHeight));
    },
    { x, y },
  );
}

/**
 * Simple scroll tool for DOM mode (non-grounding models).
 * No coordinates - scrolls from viewport center.
 */
export const scrollTool = (v3: V3) =>
  tool({
    description:
      "Scroll the page up or down by a percentage of the active scroll container height. Default is 80%, and what should be typically used for general page scrolling",
    inputSchema: z.object({
      direction: z.enum(["up", "down"]),
      percentage: z.number().min(1).max(200).optional(),
    }),
    execute: async ({
      direction,
      percentage = 80,
    }): Promise<ScrollToolResult> => {
      v3.logger({
        category: "agent",
        message: `Agent calling tool: scroll`,
        level: 1,
        auxiliary: {
          arguments: {
            value: JSON.stringify({ direction, percentage }),
            type: "object",
          },
        },
      });

      const page = await v3.context.awaitActivePage();

      const { w, h } = await page.mainFrame().evaluate<{
        w: number;
        h: number;
      }>("({ w: window.innerWidth, h: window.innerHeight })");

      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);
      const containerHeight = await getScrollContainerHeightAtPoint(page, cx, cy);
      const scrollDistance = Math.round((containerHeight * percentage) / 100);
      const deltaY = direction === "up" ? -scrollDistance : scrollDistance;

      await page.scroll(cx, cy, 0, deltaY);

      v3.recordAgentReplayStep({
        type: "scroll",
        deltaX: 0,
        deltaY,
        anchor: { x: cx, y: cy },
      });

      return {
        success: true,
        message: `Scrolled ${percentage}% ${direction} (${scrollDistance}px)`,
        scrolledPixels: scrollDistance,
      };
    },
    toModelOutput: (result) => {
      return {
        type: "json",
        value: {
          success: result.success,
          message: result.message,
          scrolledPixels: result.scrolledPixels,
        },
      };
    },
  });

/**
 * Scroll tool for hybrid mode (grounding models).
 * Supports optional coordinates for scrolling within nested scrollable elements.
 */
export const scrollVisionTool = (v3: V3, provider?: string, modelId?: string) =>
  {
    const unitScaleCoordinates = isMoonshotModel(modelId);
    const coordinateSchema = unitScaleCoordinates
      ? z.number().min(0).max(1)
      : z.number();
    const coordinateDescription = unitScaleCoordinates
      ? "Only use coordinates for scrolling inside a nested scrollable element - provide (x, y) normalized to 0..1 within that element"
      : "Only use coordinates for scrolling inside a nested scrollable element - provide (x, y) within that element";

    return tool({
    description: `Scroll the page up or down. For general page scrolling, no coordinates needed. Only provide coordinates when scrolling inside a nested scrollable element (e.g., a dropdown menu, modal with overflow, or scrollable sidebar). Default is 80%, and what should be typically used for general page scrolling`,
    inputSchema: z.object({
      direction: z.enum(["up", "down"]),
      coordinates: z
        .array(coordinateSchema)
        .optional()
        .describe(coordinateDescription),
      percentage: z.number().min(1).max(200).optional(),
    }),
    execute: async ({
      direction,
      coordinates,
      percentage = 80,
    }): Promise<ScrollVisionToolResult> => {
      const page = await v3.context.awaitActivePage();

      const { w, h } = await page.mainFrame().evaluate<{
        w: number;
        h: number;
      }>("({ w: window.innerWidth, h: window.innerHeight })");

      // Process coordinates if provided, otherwise use viewport center
      let cx: number;
      let cy: number;
      if (coordinates) {
        const processed = processCoordinates(
          coordinates[0],
          coordinates[1],
          provider,
          v3,
          modelId,
        );
        cx = processed.x;
        cy = processed.y;
      } else {
        cx = Math.floor(w / 2);
        cy = Math.floor(h / 2);
      }

      v3.logger({
        category: "agent",
        message: `Agent calling tool: scroll`,
        level: 1,
        auxiliary: {
          arguments: {
            value: JSON.stringify({
              direction,
              coordinates,
              percentage,
              processed: { cx, cy },
            }),
            type: "object",
          },
        },
      });

      const containerHeight = await getScrollContainerHeightAtPoint(page, cx, cy);
      const scrollDistance = Math.round((containerHeight * percentage) / 100);
      const deltaY = direction === "up" ? -scrollDistance : scrollDistance;

      await page.scroll(cx, cy, 0, deltaY);

      const screenshotBase64 = await waitAndCaptureScreenshot(page, 100);

      v3.recordAgentReplayStep({
        type: "scroll",
        deltaX: 0,
        deltaY,
        anchor: { x: cx, y: cy },
      });

      return {
        success: true,
        message: coordinates
          ? `Scrolled ${percentage}% ${direction} at (${cx}, ${cy})`
          : `Scrolled ${percentage}% ${direction}`,
        scrolledPixels: scrollDistance,
        screenshotBase64,
      };
    },
    toModelOutput: (result) => {
      const content: ModelOutputContentItem[] = [
        {
          type: "text",
          text: JSON.stringify({
            success: result.success,
            message: result.message,
            scrolledPixels: result.scrolledPixels,
          }),
        },
      ];
      if (result.screenshotBase64) {
        content.push({
          type: "media",
          mediaType: "image/png",
          data: result.screenshotBase64,
        });
      }
      return { type: "content", value: content };
    },
  });
};
