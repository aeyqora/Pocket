import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { eslintError } from "./errors.js";

const require = createRequire(import.meta.url);

export interface EslintComment {
  type: "Line" | "Block" | "Shebang";
  value: string;
  range: [number, number];
  loc: { start: { line: number; column: number }; end: { line: number; column: number } };
}

export interface SuppressedMessage {
  ruleId: string | null;
  suppressions?: Array<{ kind: string; justification: string }>;
}

export interface LintMessage {
  ruleId: string | null;
  message: string;
  severity: number;
  line?: number;
  fix?: { range: [number, number]; text: string };
}

/** A directive ESLint reports as unused, with the rules it names. */
export interface UnusedDirective {
  ruleNames: string[];
  isEnable: boolean;
  fixRange: [number, number] | null;
}

export interface LintResultLike {
  messages: LintMessage[];
  suppressedMessages: SuppressedMessage[];
}

export interface EffectiveConfig {
  rules?: Record<string, unknown>;
  linterOptions?: Record<string, unknown>;
  languageOptions?: Record<string, unknown>;
}

interface EslintInstance {
  lintText(
    code: string,
    options?: { filePath?: string; warnIgnored?: boolean },
  ): Promise<LintResultLike[]>;
  calculateConfigForFile(filePath: string): Promise<EffectiveConfig>;
}

interface EslintCtor {
  new (options?: Record<string, unknown>): EslintInstance;
}

interface LinterInstance {
  verify(code: string, config: unknown, options?: Record<string, unknown>): unknown;
  getSourceCode(): { getAllComments(): EslintComment[] };
}

interface LinterCtor {
  new (options?: Record<string, unknown>): LinterInstance;
}

interface EslintModule {
  ESLint?: EslintCtor;
  Linter?: LinterCtor;
}

let cachedModule: EslintModule | null = null;
let cachedBuiltinRules: Set<string> | null = null;

async function loadEslintModule(): Promise<EslintModule> {
  if (cachedModule) return cachedModule;
  let resolved: string;
  try {
    resolved = require.resolve("eslint");
  } catch (err) {
    throw eslintError("ESLint is not installed or cannot be resolved", String(err));
  }
  try {
    const mod = (await import(pathToFileURL(resolved).href)) as EslintModule;
    if (!mod.ESLint || !mod.Linter) {
      throw new Error("eslint module did not export ESLint/Linter");
    }
    cachedModule = mod;
    return mod;
  } catch (err) {
    throw eslintError("failed to load ESLint", String(err));
  }
}

function loadBuiltinRules(): Set<string> {
  if (cachedBuiltinRules) return cachedBuiltinRules;
  const names = new Set<string>();
  try {
    const p = require.resolve("eslint/use-at-your-own-risk");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(p) as {
      builtinRules?: Map<string, unknown>;
    };
    const rules = mod.builtinRules;
    if (rules) for (const name of rules.keys()) names.add(name);
  } catch {
    /* older ESLint: fall back to an empty set (validation skipped) */
  }
  cachedBuiltinRules = names;
  return names;
}

export function severityOf(value: unknown): number {
  if (value == null) return 0;
  let sev: unknown = value;
  if (Array.isArray(value)) sev = value[0];
  if (typeof sev === "number") return sev;
  if (typeof sev === "string") {
    if (sev === "off" || sev === "0") return 0;
    if (sev === "warn" || sev === "1") return 1;
    if (sev === "error" || sev === "2") return 2;
  }
  return 0;
}

/**
 * A recognition session bound to one tree (materialized baseline dir, or the
 * head worktree). Holds the normal and unused-harvest ESLint passes.
 */
export class EslintSession {
  private readonly ctor: EslintCtor;
  private readonly linterCtor: LinterCtor;
  private normal: EslintInstance | null = null;
  private unused: EslintInstance | null = null;

  private constructor(
    ctor: EslintCtor,
    linterCtor: LinterCtor,
    readonly cwd: string,
  ) {
    this.ctor = ctor;
    this.linterCtor = linterCtor;
  }

  static async create(cwd: string): Promise<EslintSession> {
    const mod = await loadEslintModule();
    return new EslintSession(mod.ESLint!, mod.Linter!, cwd);
  }

  private normalInstance(): EslintInstance {
    if (!this.normal) this.normal = new this.ctor({ cwd: this.cwd });
    return this.normal;
  }

  private unusedInstance(): EslintInstance {
    if (!this.unused) {
      this.unused = new this.ctor({
        cwd: this.cwd,
        overrideConfig: [
          { linterOptions: { reportUnusedDisableDirectives: "error" } },
        ],
      });
    }
    return this.unused;
  }

  async effectiveConfig(filePath: string): Promise<EffectiveConfig> {
    try {
      const cfg = await this.normalInstance().calculateConfigForFile(filePath);
      return cfg ?? {};
    } catch (err) {
      throw eslintError(`failed to resolve ESLint config for ${filePath}`, String(err));
    }
  }

  async lint(
    code: string,
    filePath: string,
  ): Promise<{ used: SuppressedMessage[]; unused: UnusedDirective[]; all: LintMessage[] }> {
    let pass1: LintResultLike;
    let pass2: LintResultLike;
    try {
      pass1 = (await this.normalInstance().lintText(code, { filePath }))[0]!;
    } catch (err) {
      throw eslintError(`ESLint failed to run on ${filePath}`, String(err));
    }
    try {
      pass2 = (await this.unusedInstance().lintText(code, { filePath }))[0]!;
    } catch (err) {
      throw eslintError(`ESLint failed to run on ${filePath}`, String(err));
    }
    const unused = (pass2.messages ?? [])
      .filter((m) => m.ruleId === null && /^Unused eslint-/.test(m.message))
      .map((m) => ({
        ruleNames: [...m.message.matchAll(/'([^']+)'/g)]
          .map((match) => match[1])
          .filter((name): name is string => Boolean(name)),
        isEnable: /eslint-enable/.test(m.message),
        fixRange: m.fix?.range ?? null,
      }));
    return {
      used: pass1.suppressedMessages ?? [],
      unused,
      all: pass1.messages ?? [],
    };
  }

  coreRuleNames(): Set<string> {
    return loadBuiltinRules();
  }

  comments(code: string, filePath: string, languageOptions?: Record<string, unknown>): EslintComment[] {
    try {
      const linter = new this.linterCtor({ configType: "flat", cwd: this.cwd });
      linter.verify(code, [{ languageOptions: languageOptions ?? {} }], {
        filename: filePath,
      });
      return linter.getSourceCode().getAllComments();
    } catch {
      return [];
    }
  }
}
