import type { Stagehand } from '../../stagehand/v3';

export function parseJsonFromText(text: string): unknown {
  let trimmed = text.trim();
  if (!trimmed) return {};

  const closedFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (closedFenceMatch?.[1]) {
    trimmed = closedFenceMatch[1].trim();
  } else {
    const openFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*)$/i);
    if (openFenceMatch?.[1]) {
      trimmed = openFenceMatch[1].trim();
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');

  const hasObject = firstBrace >= 0 && lastBrace > firstBrace;
  const hasArray = firstBracket >= 0 && lastBracket > firstBracket;
  const arrayFirst = hasArray && (!hasObject || firstBracket < firstBrace);

  if (arrayFirst) {
    try {
      return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
    } catch {
      // fallthrough
    }
  } else if (hasObject) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // fallthrough
    }
  }

  return JSON.parse(trimmed);
}

export async function capturePageScreenshot(
  stagehand: Stagehand,
  options?: { fullPage?: boolean },
): Promise<string> {
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const screenshot = await page.screenshot({
    fullPage: options?.fullPage ?? false,
    type: 'jpeg',
    quality: 70,
  });
  return `data:image/jpeg;base64,${Buffer.from(screenshot).toString('base64')}`;
}
