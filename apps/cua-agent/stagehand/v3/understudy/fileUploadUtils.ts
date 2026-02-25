import { promises as fs, type Stats } from "fs";
import path from "path";
import { Buffer } from "buffer";
import { StagehandInvalidArgumentError } from "../types/public/sdkErrors.js";
import {
  SetInputFilesArgument,
  SetInputFilePayload,
} from "../types/public/locator.js";
import { NormalizedFilePayload } from "../types/private/locator.js";

const DEFAULT_MIME_TYPE = "application/octet-stream";
const DEFAULT_FILE_NAME = "upload.bin";

/**
 * Normalize user-provided setInputFiles arguments into in-memory payloads.
 * - Resolves string paths relative to the provided base directory.
 * - Validates that each path exists and is a regular file.
 * - Converts all buffers into Node Buffers for downstream processing.
 */
export async function normalizeInputFiles(
  files: SetInputFilesArgument,
  opts: { baseDir?: string } = {},
): Promise<NormalizedFilePayload[]> {
  if (files === null || files === undefined) return [];

  const flattened = Array.isArray(files)
    ? (files as Array<string | SetInputFilePayload>)
    : [files];
  if (!flattened.length) return [];

  const baseDir = opts.baseDir ?? process.cwd();
  const normalized: NormalizedFilePayload[] = [];

  for (const entry of flattened) {
    if (typeof entry === "string") {
      const absolutePath = path.isAbsolute(entry)
        ? entry
        : path.resolve(baseDir, entry);
      const stat = await statFile(absolutePath);
      if (!stat.isFile()) {
        throw new StagehandInvalidArgumentError(
          `setInputFiles(): expected a file but received directory or special entry at ${absolutePath}`,
        );
      }
      const buffer = await fs.readFile(absolutePath);
      normalized.push({
        name: path.basename(absolutePath) || DEFAULT_FILE_NAME,
        mimeType: DEFAULT_MIME_TYPE,
        buffer,
        lastModified: stat.mtimeMs || Date.now(),
        absolutePath,
      });
      continue;
    }

    if (entry && typeof entry === "object" && "buffer" in entry) {
      const payload = entry as SetInputFilePayload;
      const buffer = toBuffer(payload.buffer);
      normalized.push({
        name: normalizePayloadFileName(payload.name),
        mimeType:
          typeof payload.mimeType === "string" && payload.mimeType.trim().length
            ? payload.mimeType
            : DEFAULT_MIME_TYPE,
        buffer,
        lastModified:
          typeof payload.lastModified === "number"
            ? payload.lastModified
            : Date.now(),
      });
      continue;
    }

    throw new StagehandInvalidArgumentError(
      "setInputFiles(): expected file path(s) or payload object(s)",
    );
  }

  return normalized;
}

async function statFile(absolutePath: string): Promise<Stats> {
  try {
    return await fs.stat(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new StagehandInvalidArgumentError(
        `setInputFiles(): file not found at ${absolutePath}`,
      );
    }
    throw error;
  }
}

export function toBuffer(
  data: ArrayBuffer | Uint8Array | Buffer | string,
): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  throw new StagehandInvalidArgumentError(
    "Unsupported file payload buffer type",
  );
}

function normalizePayloadFileName(name: unknown): string {
  if (typeof name === "string" && name.trim().length > 0) {
    return name;
  }
  if (typeof name === "number" && Number.isFinite(name)) {
    return String(name);
  }
  return DEFAULT_FILE_NAME;
}
