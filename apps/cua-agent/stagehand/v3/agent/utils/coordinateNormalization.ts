import type { V3 } from '../../v3.js';
import type { Page } from '../../understudy/page.js';

// Default viewport for advancedStealth mode
const STEALTH_VIEWPORT = { width: 1288, height: 711 };

export function isGoogleProvider(provider?: string): boolean {
  if (!provider) return false;
  return provider.toLowerCase().includes('google');
}

// Moonshot (kimi) models return coordinates in a 0-1 range, we need to scale
// them to the viewport dimensions
export function isMoonshotModel(modelId?: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return lower.includes('moonshot') || lower.includes('kimi');
}

// Google returns coordinates in a 0-1000 range, we need to normalize
// them to the viewport dimensions
export function normalizeGoogleCoordinates(
  x: number,
  y: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const clampedX = Math.min(999, Math.max(0, x));
  const clampedY = Math.min(999, Math.max(0, y));
  return {
    x: Math.floor((clampedX / 1000) * viewport.width),
    y: Math.floor((clampedY / 1000) * viewport.height),
  };
}

// Moonshot returns coordinates in a 0-1 range, we need to scale
// them to the viewport dimensions
export function normalizeMoonshotCoordinates(
  x: number,
  y: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.floor(Math.min(1, Math.max(0, x)) * viewport.width),
    y: Math.floor(Math.min(1, Math.max(0, y)) * viewport.height),
  };
}

async function getLiveViewport(page: Page): Promise<{ width: number; height: number } | undefined> {
  try {
    const viewport = await page.mainFrame().evaluate<{
      width: number;
      height: number;
    }>(`(() => {
      const visual = window.visualViewport;
      const width = Math.round(
        visual?.width ??
          window.innerWidth ??
          document.documentElement?.clientWidth ??
          0,
      );
      const height = Math.round(
        visual?.height ??
          window.innerHeight ??
          document.documentElement?.clientHeight ??
          0,
      );
      return { width, height };
    })()`);

    if (viewport.width > 0 && viewport.height > 0) {
      return viewport;
    }
  } catch {
    // Fall back to configured viewport below.
  }

  return undefined;
}

async function getViewportForCoordinateNormalization(
  v3?: V3,
  page?: Page,
): Promise<{ width: number; height: number } | undefined> {
  if (v3?.isAdvancedStealth) {
    return STEALTH_VIEWPORT;
  }

  const activePage = page ?? (v3 ? await v3.context.awaitActivePage() : undefined);
  if (activePage) {
    const liveViewport = await getLiveViewport(activePage);
    if (liveViewport) {
      return liveViewport;
    }
  }

  if (v3) {
    return v3.configuredViewport;
  }

  return undefined;
}

export async function processCoordinates(
  x: number,
  y: number,
  provider?: string,
  v3?: V3,
  modelId?: string,
  page?: Page,
): Promise<{ x: number; y: number }> {
  const viewport = await getViewportForCoordinateNormalization(v3, page);
  if (viewport) {
    if (isGoogleProvider(provider)) {
      return normalizeGoogleCoordinates(x, y, viewport);
    }

    if (isMoonshotModel(modelId) && x <= 1 && y <= 1) {
      return normalizeMoonshotCoordinates(x, y, viewport);
    }
  }
  return { x, y };
}
