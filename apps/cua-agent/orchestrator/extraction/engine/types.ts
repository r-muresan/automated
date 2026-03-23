export type ExtractionMode = 'spreadsheet' | 'files' | 'dom' | 'vision';

export type ExtractOutput = {
  scraped_data: unknown;
  mode: ExtractionMode;
};

export interface Extractor {
  name: string;
  tryExtract: () => Promise<ExtractOutput | null>;
}
