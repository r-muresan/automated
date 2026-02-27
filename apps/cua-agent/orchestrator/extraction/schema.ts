import { z } from 'zod';

type SchemaMap = Record<string, string>;

export type ParsedSchema = {
  raw: string;
  properties: SchemaMap;
};

export function parseSchemaMap(schemaText?: string): ParsedSchema | null {
  if (!schemaText) return null;
  const trimmed = schemaText.trim();
  if (!trimmed) return null;

  const tryParse = (text: string): SchemaMap | null => {
    try {
      const parsed = JSON.parse(text) as SchemaMap;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) {
    return { raw: JSON.stringify(direct, null, 2), properties: direct };
  }

  const normalized = trimmed.replace(/([a-zA-Z0-9_]+)\s*:/g, '"$1":').replace(/'/g, '"');

  const parsed = tryParse(normalized);
  if (!parsed) return null;
  return { raw: JSON.stringify(parsed, null, 2), properties: parsed };
}

export function buildJsonSchemaFromMap(schema: ParsedSchema): string {
  const properties: Record<string, { type: string }> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(schema.properties)) {
    const normalized = String(value || 'string').toLowerCase();
    let type = 'string';
    if (['number', 'integer'].includes(normalized)) type = 'number';
    if (['boolean', 'bool'].includes(normalized)) type = 'boolean';
    if (['array', 'list'].includes(normalized)) type = 'array';
    if (['object', 'dict', 'map'].includes(normalized)) type = 'object';
    properties[key] = { type };
    required.push(key);
  }

  const jsonSchema = {
    type: 'object',
    properties,
    required,
  };

  return JSON.stringify(jsonSchema, null, 2);
}

function schemaTypeToZod(typeValue: string): z.ZodTypeAny {
  const normalized = String(typeValue || 'string').trim().toLowerCase();

  if (['number', 'integer'].includes(normalized)) return z.number().nullable();
  if (['boolean', 'bool'].includes(normalized)) return z.boolean().nullable();
  if (['array', 'list'].includes(normalized)) return z.array(z.unknown()).nullable();
  if (['object', 'dict', 'map'].includes(normalized)) {
    return z.record(z.string(), z.unknown()).nullable();
  }

  return z.string().nullable();
}

export function buildZodObjectFromMap(schema: ParsedSchema): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    shape[key] = schemaTypeToZod(value);
  }
  return z.object(shape);
}

export function validateAndFillExtractionResult(
  extractionResult: unknown,
  schema: ParsedSchema,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const resultObj =
    extractionResult && typeof extractionResult === 'object' && !Array.isArray(extractionResult)
      ? (extractionResult as Record<string, unknown>)
      : {};

  for (const key of Object.keys(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(resultObj, key)) {
      output[key] = resultObj[key];
    } else {
      output[key] = null;
    }
  }

  return output;
}

function normalizeLoopItem(item: unknown): Record<string, unknown> {
  if (item == null) return { text: '' };
  if (typeof item === 'string') return { text: item };
  if (typeof item === 'number' || typeof item === 'boolean') {
    return { text: String(item) };
  }
  if (typeof item === 'object') {
    if (!Array.isArray(item)) {
      const asRecord = item as Record<string, unknown>;
      if (typeof asRecord.text === 'string') return { ...asRecord };
      const firstStringValue = Object.values(asRecord).find((value) => typeof value === 'string');
      if (typeof firstStringValue === 'string') {
        return { ...asRecord, text: firstStringValue };
      }
      return { ...asRecord, text: JSON.stringify(asRecord) };
    }
    return { text: JSON.stringify(item) };
  }
  return { text: String(item) };
}

export function normalizeLoopItems(extractionResult: unknown): { items: Array<Record<string, unknown>> } {
  if (Array.isArray(extractionResult)) {
    return {
      items: extractionResult.map((item) => normalizeLoopItem(item)),
    };
  }

  const rawItems =
    extractionResult && typeof extractionResult === 'object'
      ? (extractionResult as Record<string, unknown>).items
      : null;
  if (!Array.isArray(rawItems)) {
    return { items: [] };
  }

  return { items: rawItems.map((item) => normalizeLoopItem(item)) };
}
