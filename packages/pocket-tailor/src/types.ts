import type { AST, Rule } from "eslint";

/**
 * Where a report points: a full source location, or a bare position (which
 * ESLint normalizes into a start-only location).
 */
export type ReportLocation = AST.SourceLocation | { line: number; column: number };

/**
 * The report fields shared by an upstream {@link Detection}, a hook's returned
 * {@link TailoredReport}, and the internal descriptor they are merged into:
 * what is reported, where, under which message id and data, and with which fix
 * or suggestions.
 */
export interface ReportFields {
  messageId?: string;
  message?: string;
  data?: Record<string, unknown>;
  node?: Rule.Node;
  loc?: ReportLocation;
  fix?: Rule.ReportFixer | null;
  suggest?: Rule.SuggestionReportDescriptor[] | null;
}

/**
 * The upstream report details handed to a tailoring's `report()` hook: what the
 * upstream rule detected, where, under which message id and data, plus the
 * options the user configured.
 */
export interface Detection extends ReportFields {
  /** The rule options exactly as configured (upstream `defaultOptions` merged). */
  options: readonly unknown[];
}

/**
 * Helpers passed alongside a detection to the `report()` hook.
 *
 * `message(id, data)` resolves a message id against the composed rule's
 * messages (upstream plus authored) and interpolates ESLint's `{{placeholder}}`
 * syntax with the report data.
 */
export interface ReportHelpers {
  message(id: string, data?: Record<string, unknown> | null): string;
  sourceCode: Rule.RuleContext["sourceCode"];
  options: readonly unknown[];
  filename: string;
  settings: Rule.RuleContext["settings"];
}

/**
 * A report returned by a `report()` hook. Any field left out is inherited from
 * the upstream detection — most importantly the location, so a hook can return
 * `{ message }` alone.
 */
export interface TailoredReport extends ReportFields {
  /**
   * Description for the editor suggestion an authored `fix` becomes when the
   * tailoring did not opt into `autofix: true`. Ignored when the report already
   * carries `suggest` entries, or when the fix is applied as an autofix.
   */
  suggestionDesc?: string;
  /**
   * `messageId` (resolved against the composed rule's messages) for the
   * suggestion an authored `fix` becomes. Takes precedence over
   * `suggestionDesc`. Ignored in the same cases as `suggestionDesc`.
   */
  suggestionMessageId?: string;
  /** Placeholder data for a `suggestionMessageId`. */
  suggestionData?: Record<string, unknown>;
}

/**
 * The single entry point of a tailored rule: invoked once per upstream
 * detection. Return a {@link TailoredReport} to reshape the report, or nothing
 * to forward the upstream report untouched. There is no suppression mechanism.
 */
export type ReportHook = (
  detection: Detection,
  helpers: ReportHelpers,
) => TailoredReport | null | undefined | void;

/** Authored documentation metadata required of every tailored rule. */
export interface TailoringDocs {
  /** A short, human-readable summary of what this tailored rule enforces. */
  description: string;
  /** An absolute http(s) URL for the rule's documentation. */
  url: string;
}

/** Authored rule metadata. `messages` are merged over the upstream messages. */export interface TailoringMeta {
  /** Required documentation metadata; powers the editor's rule link. */
  docs: TailoringDocs;
  messages?: Record<string, string>;
  type?: Rule.RuleMetaData["type"];
}

/**
 * A tailoring definition: which upstream rule is tailored, its authored `meta`,
 * and its `report()` hook.
 */
export interface TailoringDefinition {
  /** The upstream rule, referenced by name inside a plugin or by direct module. */
  tailors: string | Rule.RuleModule;
  /** Authored metadata. `docs` is required; `message`, `messages`, or `report` must tailor presentation. */
  meta: TailoringMeta;
  /**
   * One message for every detection of this rule, regardless of whether
   * upstream reports with `messageId` or a plain `message`. Interpolates
   * upstream `data` with `{{placeholder}}`. A `report()` result wins.
   */
  message?: string;
  /**
   * Opt an authored `fix` into `--fix` by synthesizing `meta.fixable`. When
   * omitted (or `false`), an authored fix becomes an editor suggestion and
   * `--fix` leaves the file alone (ADR-0003).
   */
  autofix?: boolean;
  report?: ReportHook;
}

/** A rule module from an upstream plugin. Upstream always owns detection. */
export type UpstreamRuleModule = Rule.RuleModule;

/** An upstream plugin object: a bag of rule modules plus optional configs. */
export interface UpstreamPlugin {
  meta?: { name?: string; version?: string; namespace?: string };
  rules?: Record<string, UpstreamRuleModule>;
  configs?: Record<string, unknown>;
  processors?: Record<string, unknown>;
  languages?: Record<string, unknown>;
}

/**
 * Marks a module as a tailored rule and carries its definition, so `tailor()`
 * (and tests) can read `tailors` back off the module.
 */
export const TAILORING: unique symbol = Symbol.for("pocket-tailor.definition");

/** A rule module composed from an upstream rule and a tailoring definition. */
export interface TailoredRuleModule extends Rule.RuleModule {
  readonly [TAILORING]: TailoringDefinition;
}
