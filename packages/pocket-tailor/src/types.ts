import type { AST, Rule } from "eslint";

/**
 * Where a report points: a full source location, or a bare position (which
 * ESLint normalizes into a start-only location).
 */
export type ReportLocation = AST.SourceLocation | { line: number; column: number };

/**
 * The upstream report details handed to a tailoring's `report()` hook: what the
 * upstream rule detected, where, under which message id and data, plus the
 * options the user configured.
 */
export interface Detection {
  messageId?: string;
  message?: string;
  data?: Record<string, unknown>;
  node?: Rule.Node;
  loc?: ReportLocation;
  fix?: Rule.ReportFixer | null;
  suggest?: Rule.SuggestionReportDescriptor[] | null;
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
export interface TailoredReport {
  message?: string;
  messageId?: string;
  data?: Record<string, unknown>;
  node?: Rule.Node;
  loc?: ReportLocation;
  fix?: Rule.ReportFixer | null;
  suggest?: Rule.SuggestionReportDescriptor[] | null;
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

/** Authored rule metadata. `messages` are merged over the upstream messages. */
export interface TailoringMeta {
  messages?: Record<string, string>;
  docs?: Rule.RuleMetaData["docs"];
  type?: Rule.RuleMetaData["type"];
}

/**
 * A tailoring definition: which upstream rule is tailored, its authored `meta`,
 * and its `report()` hook. `autofix` is reserved for injected fixes (ticket 03).
 */
export interface TailoringDefinition {
  /** The upstream rule, referenced by name inside a plugin or by direct module. */
  tailors: string | Rule.RuleModule;
  autofix?: boolean;
  meta?: TailoringMeta;
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
  environments?: Record<string, unknown>;
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
