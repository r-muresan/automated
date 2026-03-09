import { createHash } from 'crypto';

const TRANSIENT_FIELDS = new Set([
  'cacheStatus',
  'timestamp',
  'createdAt',
  'updatedAt',
  'time',
  'date',
  'rank',
  'position',
  'index',
]);

const STRONG_FIELD_GROUPS: string[][] = [
  ['selector', 'xpath', 'cssSelector', 'css', 'locator'],
  ['id', 'elementId', 'dataId', 'data-id', 'data-testid', 'testId'],
  ['href', 'url', 'link'],
  ['fileId', 'remotePath', 'filename'],
  ['text', 'title', 'name', 'label', 'ariaLabel', 'aria-label'],
];

function normalizeKeyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeStringValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeScalar(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const normalized = normalizeStringValue(value);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function getFieldValue(item: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      const direct = normalizeScalar(item[key]);
      if (direct) return direct;
    }
  }

  const normalizedCandidates = new Set(candidates.map((candidate) => normalizeKeyName(candidate)));
  for (const [key, value] of Object.entries(item)) {
    if (!normalizedCandidates.has(normalizeKeyName(key))) continue;
    const resolved = normalizeScalar(value);
    if (resolved) return resolved;
  }

  return undefined;
}

function buildIdentityBasis(item: Record<string, unknown>): string | undefined {
  const parts: string[] = [];

  for (const group of STRONG_FIELD_GROUPS) {
    const value = getFieldValue(item, group);
    if (!value) continue;

    const label = normalizeKeyName(group[0]);
    parts.push(`${label}=${value}`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join('|');
}

function sanitizeForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForStableStringify(entry));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (TRANSIENT_FIELDS.has(key)) continue;
      result[key] = sanitizeForStableStringify((value as Record<string, unknown>)[key]);
    }
    return result;
  }

  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sanitizeForStableStringify(value));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function buildDeterministicItemKey(item: Record<string, unknown>): string {
  const identityBasis = buildIdentityBasis(item);
  if (identityBasis) {
    return `item:${digest(identityBasis)}`;
  }

  return `item:${digest(stableStringify(item))}`;
}
