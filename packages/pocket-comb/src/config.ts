import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "./errors.js";
import { REPORT_FORMATS, type ReportFormat } from "./types.js";

/** The `replace` action's rename pair. */
export interface ReplacePair {
  from: string;
  to: string;
}

/** The `report` tool knob: the post-run report's format and destination. */
export interface ReportSetting {
  format: ReportFormat;
  out: string;
}

/** The namespaced, free-form tool block: `settings["pocket-comb"]`. */
export interface PocketCombSettings {
  target?: string;
  replace?: ReplacePair;
  report?: ReportSetting;
}

/**
 * The action config, resolved. Paths are absolute; `configHash` is the sha256 of
 * the config file's raw bytes (carried into every report's run metadata).
 */
export interface LoadedConfig {
  configPath: string;
  configHash: string;
  /** flag > settings.target (resolved against the config's dir) > cwd */
  targetRoot: string;
  /** flag > settings.replace */
  replace?: ReplacePair;
  /** flag > settings.report */
  report?: ReportSetting;
  /** Rule names whose severity is actionable (> 0), deduplicated, in config order. */
  rules: string[];
  /** The merged `settings["pocket-comb"]` block, exactly as configured. */
  settings: PocketCombSettings;
  /** The config module's default export, for later stages that need it. */
  rawConfig: unknown;
}

export interface LoadConfigOptions {
  configFlag?: string;
  targetFlag?: string;
  /** The `--from`/`--to` pair, when the caller carries both. */
  replaceFlag?: ReplacePair;
  /** The `--format`/`--out` pair, when the caller carries both. */
  reportFlag?: ReportSetting;
  cwd: string;
}

const AUTO_DETECT_NAMES = [
  "pocket-comb.config.js",
  "pocket-comb.config.mjs",
  "pocket-comb.config.cjs",
  "pocket-comb.config.json",
] as const;

/** The cwd convention: the first `pocket-comb.config.{js,mjs,cjs,json}` that exists. */
export function autoDetectConfig(cwd: string): string | undefined {
  for (const name of AUTO_DETECT_NAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Severity is membership: `> 0` (warn or error) is actionable, `1` and `2` behave
 * identically, `"off"` is excluded. Handles both bare severities and
 * `[severity, ...options]` tuples.
 */
export function isActionableRule(severity: unknown): boolean {
  const value = Array.isArray(severity) ? severity[0] : severity;
  if (typeof value === "number") return value > 0;
  return value === "warn" || value === "error";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const cwd = resolve(options.cwd);
  const configPath = resolveConfigPath(options.configFlag, cwd);
  const bytes = readConfigBytes(configPath);
  const configHash = createHash("sha256").update(bytes).digest("hex");
  const rawConfig = await importConfig(configPath, bytes);

  const objects = configObjects(rawConfig, configPath);
  const settings = mergeSettings(objects);
  const rules = collectRules(objects);

  return {
    configPath,
    configHash,
    targetRoot: resolveTarget(options.targetFlag, settings, configPath, cwd),
    replace: options.replaceFlag ?? settings.replace,
    report: options.reportFlag ?? settings.report,
    rules,
    settings,
    rawConfig,
  };
}

function resolveConfigPath(configFlag: string | undefined, cwd: string): string {
  if (configFlag !== undefined && configFlag !== "") {
    return isAbsolute(configFlag) ? configFlag : resolve(cwd, configFlag);
  }
  const detected = autoDetectConfig(cwd);
  if (detected === undefined) {
    throw new ConfigError(
      `no action config found: pass --config <path>, or create ` +
        `pocket-comb.config.{js,mjs,cjs,json} in ${cwd}`,
    );
  }
  return detected;
}

function readConfigBytes(configPath: string): Buffer {
  try {
    return readFileSync(configPath);
  } catch (err) {
    throw new ConfigError(`could not read action config '${configPath}': ${message(err)}`, {
      cause: err,
    });
  }
}

async function importConfig(configPath: string, bytes: Buffer): Promise<unknown> {
  if (configPath.endsWith(".json")) {
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      throw new ConfigError(`could not parse action config '${configPath}': ${message(err)}`, {
        cause: err,
      });
    }
  }

  // An mtime query busts the ESM module cache the way ESLint's own loader does,
  // so a config edited between runs is re-imported rather than served stale.
  const url = pathToFileURL(configPath);
  url.searchParams.set("mtime", String(Date.now()));
  let loaded: unknown;
  try {
    loaded = await import(url.href);
  } catch (err) {
    throw new ConfigError(`could not load action config '${configPath}': ${message(err)}`, {
      cause: err,
    });
  }
  const namespace = loaded as { default?: unknown };
  return namespace.default ?? namespace;
}

function configObjects(raw: unknown, configPath: string): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      `action config '${configPath}' must export an array of flat config objects`,
    );
  }
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new ConfigError(`action config '${configPath}' has a non-object entry at index ${index}`);
    }
    return entry as Record<string, unknown>;
  });
}

function collectRules(objects: Array<Record<string, unknown>>): string[] {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const object of objects) {
    const block = object.rules;
    if (block === null || typeof block !== "object") continue;
    for (const [rule, severity] of Object.entries(block as Record<string, unknown>)) {
      if (isActionableRule(severity) && !seen.has(rule)) {
        seen.add(rule);
        rules.push(rule);
      }
    }
  }
  return rules;
}

function mergeSettings(objects: Array<Record<string, unknown>>): PocketCombSettings {
  const merged: Record<string, unknown> = {};
  for (const object of objects) {
    const settings = object.settings;
    if (settings === null || typeof settings !== "object") continue;
    const block = (settings as Record<string, unknown>)["pocket-comb"];
    if (block === null || typeof block !== "object") continue;
    Object.assign(merged, block);
  }
  return validateSettings(merged);
}

function validateSettings(merged: Record<string, unknown>): PocketCombSettings {
  const settings: PocketCombSettings = {};

  const target = merged.target;
  if (target !== undefined) {
    if (typeof target !== "string" || target === "") {
      throw new ConfigError(`settings["pocket-comb"].target must be a non-empty string`);
    }
    settings.target = target;
  }

  const replace = merged.replace;
  if (replace !== undefined) {
    if (replace === null || typeof replace !== "object") {
      throw new ConfigError(`settings["pocket-comb"].replace must be a { from, to } object`);
    }
    const { from, to } = replace as Record<string, unknown>;
    if (typeof from !== "string" || from === "" || typeof to !== "string" || to === "") {
      throw new ConfigError(`settings["pocket-comb"].replace needs non-empty string 'from' and 'to'`);
    }
    settings.replace = { from, to };
  }

  const report = merged.report;
  if (report !== undefined) {
    if (report === null || typeof report !== "object") {
      throw new ConfigError(
        `settings["pocket-comb"].report must be a { format, out } object`,
      );
    }
    const { format, out } = report as Record<string, unknown>;
    if (typeof format !== "string" || !(REPORT_FORMATS as readonly string[]).includes(format)) {
      throw new ConfigError(
        `settings["pocket-comb"].report.format must be one of ${REPORT_FORMATS.join(" | ")}`,
      );
    }
    if (typeof out !== "string" || out === "") {
      throw new ConfigError(`settings["pocket-comb"].report.out must be a non-empty string`);
    }
    settings.report = { format: format as ReportFormat, out };
  }

  return settings;
}

function resolveTarget(
  targetFlag: string | undefined,
  settings: PocketCombSettings,
  configPath: string,
  cwd: string,
): string {
  if (targetFlag !== undefined && targetFlag !== "") {
    return resolve(cwd, targetFlag);
  }
  if (settings.target !== undefined) {
    // A relative settings.target is self-contained: it resolves against the
    // config file's own directory, never against the cwd.
    return resolve(dirname(configPath), settings.target);
  }
  return cwd;
}
