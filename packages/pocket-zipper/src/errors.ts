import type { ErrorCode } from "./types.js";

export class PocketZipperError extends Error {
  readonly code: ErrorCode;
  readonly detail: unknown;

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "PocketZipperError";
    this.code = code;
    this.detail = detail;
  }
}

export function gitError(message: string, detail?: unknown): PocketZipperError {
  return new PocketZipperError("GIT_ERROR", message, detail);
}

export function eslintError(message: string, detail?: unknown): PocketZipperError {
  return new PocketZipperError("ESLINT_ERROR", message, detail);
}

export function configError(message: string, detail?: unknown): PocketZipperError {
  return new PocketZipperError("CONFIG_ERROR", message, detail);
}
