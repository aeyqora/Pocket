/**
 * Typed operational errors. The exit-code contract is 0 success, 1 dry run with
 * impact, 2 operational error; every error here is an operational error, and the
 * single top-level handler in `cli.ts` maps it to exit 2 with its message.
 */
export class OperationalError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid input on the CLI surface: unknown verb, unknown flag, bad value. */
export class UsageError extends OperationalError {}

/** The action config could not be found, read, parsed, or loaded. */
export class ConfigError extends OperationalError {}

export function isOperationalError(value: unknown): value is OperationalError {
  return value instanceof OperationalError;
}
