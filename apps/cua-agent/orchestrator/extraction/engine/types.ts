import type { ParsedSchema } from '../schema';

export type ExtractionMode = 'spreadsheet' | 'files' | 'dom' | 'vision';

export type ExtractOutput = {
  scraped_data: unknown;
  mode: ExtractionMode;
};

export interface Extractor {
  name: string;
  tryExtract: () => Promise<ExtractOutput | null>;
}

export function applyValidation(
  data: unknown,
  schema: ParsedSchema | null | undefined,
  skipValidation: boolean | undefined,
  validateFn: (data: unknown, schema: ParsedSchema) => unknown,
): unknown {
  return schema && !skipValidation ? validateFn(data, schema) : data;
}
