import type { ErrorCode } from "./types.js";

export class PocketLockError extends Error {
  readonly code: ErrorCode;
  readonly detail: unknown;

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "PocketLockError";
    this.code = code;
    this.detail = detail;
  }
}

export function gitError(message: string, detail?: unknown): PocketLockError {
  return new PocketLockError("GIT_ERROR", message, detail);
}

export function eslintError(message: string, detail?: unknown): PocketLockError {
  return new PocketLockError("ESLINT_ERROR", message, detail);
}

export function configError(message: string, detail?: unknown): PocketLockError {
  return new PocketLockError("CONFIG_ERROR", message, detail);
}
