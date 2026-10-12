import type { Rule } from "eslint";
import { interpolate } from "./interpolate.js";
import {
  TAILORING,
  type Detection,
  type ReportFields,
  type ReportHelpers,
  type ReportLocation,
  type TailoredReport,
  type TailoredRuleModule,
  type TailoringDefinition,
} from "./types.js";

/** A `context.report()` call normalized into one object. */
interface ReportDescriptor extends ReportFields {
  suggestionDesc?: string;
  suggestionMessageId?: string;
  suggestionData?: Record<string, unknown>;
}

/** Generic description for a fix that becomes a suggestion with no authored one. */
const DEFAULT_SUGGESTION_DESC = "Apply the tailored fix.";

/**
 * Turn the report's authored `fix` into a single editor suggestion, carrying
 * the descriptor's `suggestion*` fields as its message. Any `suggest` array the
 * hook already returned is kept and the converted fix is appended, so no
 * authored suggestion is ever dropped.
 */
function fixAsSuggestion(descriptor: ReportDescriptor, fix: Rule.ReportFixer): void {
  const { suggestionDesc, suggestionMessageId, suggestionData } = descriptor;
  // `data` is typed loosely on the tailoring surface and narrowed here, same as
  // the report descriptor itself (`TailoredReport.data` is `Record<string, unknown>`).
  const suggestion = (
    suggestionMessageId
      ? { messageId: suggestionMessageId, fix, ...(suggestionData ? { data: suggestionData } : {}) }
      : { desc: suggestionDesc ?? DEFAULT_SUGGESTION_DESC, fix }
  ) as Rule.SuggestionReportDescriptor;

  descriptor.suggest = descriptor.suggest ? [...descriptor.suggest, suggestion] : [suggestion];
  delete descriptor.fix;
}

/**
 * Route an *authored* fix according to the tailoring's `autofix` declaration
 * (ADR-0003). `autofix: true` leaves it a real fix (the composed meta carries
 * `fixable`); otherwise it becomes a suggestion and `--fix` does not apply it.
 *
 * Only a fix the hook itself returned is routed. A fix merely inherited from
 * the upstream report (the hook reshaped the message and left `fix` alone)
 * passes through untouched, so a message-only tailoring never silently turns
 * off an upstream autofix. The `suggestion*` helper fields never reach ESLint
 * as report keys.
 */
function routeReportFix(
  descriptor: ReportDescriptor,
  authoredFix: boolean,
  autofix: boolean,
): ReportDescriptor {
  if (authoredFix && descriptor.fix && !autofix) {
    fixAsSuggestion(descriptor, descriptor.fix);
  }

  // These helper fields are not ESLint report keys; `fixAsSuggestion` may have
  // consumed them, so strip whatever remains before the descriptor is reported.
  delete descriptor.suggestionDesc;
  delete descriptor.suggestionMessageId;
  delete descriptor.suggestionData;

  return descriptor;
}

/**
 * Translate any of ESLint's three `context.report()` call forms into a single
 * descriptor, mirroring `normalizeMultiArgReportCall` exactly so a pass-through
 * report keeps its original message and location:
 *
 * 1. `report(descriptor)`
 * 2. `report(node, message, data?, fix?)`
 * 3. `report(node, loc, message, data?, fix?)`
 */
function normalizeReportArgs(args: unknown[]): ReportDescriptor {
  if (args.length === 1) {
    return (args[0] ?? {}) as ReportDescriptor;
  }
  if (typeof args[1] === "string") {
    return {
      node: args[0] as Rule.Node,
      message: args[1],
      data: args[2] as Record<string, unknown>,
      fix: args[3] as Rule.ReportFixer,
    };
  }
  return {
    node: args[0] as Rule.Node,
    loc: args[1] as ReportLocation,
    message: args[2] as string,
    data: args[3] as Record<string, unknown>,
    fix: args[4] as Rule.ReportFixer,
  };
}

/**
 * Merge a hook's report into the upstream detection. Fields the hook omits are
 * inherited from upstream (so location survives), then the descriptor is
 * normalized to what ESLint accepts:
 *
 * - location: `loc` wins over `node` in ESLint, so never carry both. When the
 *   hook returns both, `loc` is kept and `node` is dropped; when it returns
 *   only one, that one is kept.
 * - message: exactly one of `message` / `messageId` may reach ESLint.
 */
function mergeReport(base: ReportDescriptor, next: TailoredReport): ReportDescriptor {
  const merged: ReportDescriptor = { ...base, ...next };

  if (next.loc !== undefined) {
    delete merged.node;
  } else if (next.node !== undefined) {
    delete merged.loc;
  }

  if (next.messageId !== undefined && next.messageId !== "") {
    delete merged.message;
  } else if (next.message !== undefined) {
    delete merged.messageId;
  }

  return merged;
}

/**
 * Wrap an authored fix so its result is range-checked before ESLint sees it.
 *
 * ESLint validates that a fix's `range` is two numbers and that fixes do not
 * overlap, but it silently clamps a numeric range that falls outside the source
 * (`SourceCodeFixer`). An out-of-range authored fix is an authoring mistake that
 * would corrupt output, so it fails here instead — named after the tailored
 * rule — while a malformed range is left to ESLint's own `assertValidFix` error.
 */
function guardAuthoredFix(
  fix: Rule.ReportFixer,
  sourceLength: number,
  ruleLabel: string,
): Rule.ReportFixer {
  return (fixer) => {
    const result = fix(fixer);
    assertAuthoredFixRange(result, sourceLength, ruleLabel);
    return result;
  };
}

function assertAuthoredFixRange(
  result: Rule.Fix | Iterable<Rule.Fix> | null,
  sourceLength: number,
  ruleLabel: string,
): void {
  if (!result) return;
  // A fix may be a single edit or an iterable of edits (ESLint's `mergeFixes`
  // accepts both), so every edit is checked.
  const fixes: Iterable<unknown> = Symbol.iterator in result ? result : [result];
  for (const fix of fixes) {
    assertFixInRange(fix, sourceLength, ruleLabel);
  }
}

function assertFixInRange(fix: unknown, sourceLength: number, ruleLabel: string): void {
  if (typeof fix !== "object" || fix === null) return;
  const { range } = fix as { range?: unknown };
  // A malformed range is ESLint's to report (`Fix has invalid range`).
  if (!Array.isArray(range) || range.length !== 2) return;
  const [start, end] = range as [unknown, unknown];
  if (typeof start !== "number" || typeof end !== "number") return;
  if (start < 0 || end < start || end > sourceLength) {
    throw new Error(
      `pocket-tailor: tailored rule '${ruleLabel}' produced a fix outside the source range: ` +
        `[${start}, ${end}] is not within [0, ${sourceLength}]. ESLint would otherwise clamp ` +
        `it silently; fix the authored range.`,
    );
  }
}

/**
 * Compose an upstream rule module with a tailoring definition into a runnable
 * rule module.
 *
 * The upstream `create()` runs detection unchanged; a proxy context routes every
 * `context.report()` through the tailoring's `report()` hook. A hook that
 * returns nothing forwards the upstream descriptor untouched — no report can be
 * dropped. Options are forwarded verbatim: the composed `meta.schema` and
 * `meta.defaultOptions` always come from upstream.
 */
export function composeRule(
  upstream: Rule.RuleModule,
  definition: TailoringDefinition,
): TailoredRuleModule {
  const upstreamMeta = upstream.meta ?? {};
  const autofix = definition.autofix === true;
  const messages: Record<string, string> = {
    ...(upstreamMeta.messages ?? {}),
    ...(definition.meta?.messages ?? {}),
  };

  // ESLint requires `fixable` and `hasSuggestions` to be declared statically on
  // `meta`, but `meta` is built before any report exists — so the composed rule
  // can only declare a *capability*, never the presence of a fix or suggestion
  // in a particular report. ESLint reads the composed meta, not upstream's:
  // - `fixable` is declared only under `autofix: true` (an authored fix is a
  //   real `--fix` autofix); reuse upstream's fix type so a whitespace rule
  //   stays whitespace-fixable.
  // - `hasSuggestions` is declared in suggestion mode (`autofix !== true`, the
  //   only mode where an authored fix becomes a suggestion) or when upstream
  //   already declares it. Under `autofix: true`, upstream's own suggestions are
  //   still kept, so upstream's declaration is preserved.
  // Over-declaring a capability is harmless: a rule that ends up emitting no
  // fix/suggestion is never rejected for a capability it did not use.
  const fixable = autofix ? (upstreamMeta.fixable ?? "code") : upstreamMeta.fixable;
  const hasSuggestions = autofix ? upstreamMeta.hasSuggestions : true;

  // A human-readable name for this tailored rule, used in error messages.
  const ruleLabel =
    typeof definition.tailors === "string"
      ? definition.tailors
      : (definition.meta?.docs?.description ?? "tailored rule");

  const meta: Rule.RuleMetaData = {
    ...upstreamMeta,
    ...(definition.meta ?? {}),
    ...(fixable === undefined ? {} : { fixable }),
    ...(hasSuggestions === undefined ? {} : { hasSuggestions }),
    messages,
    schema: upstreamMeta.schema,
    defaultOptions: upstreamMeta.defaultOptions,
  };

  function create(context: Rule.RuleContext): Rule.RuleListener {
    const report = definition.report;
    const originalReport = context.report;

    const helpers: ReportHelpers = {
      message(id, data) {
        const template = messages[id];
        if (typeof template !== "string") {
          throw new TypeError(
            `pocket-tailor: unknown messageId '${id}'. Known ids: ${
              Object.keys(messages).join(", ") || "(none)"
            }.`,
          );
        }
        return interpolate(template, data);
      },
      sourceCode: context.sourceCode,
      options: context.options,
      filename: context.filename,
      settings: context.settings,
    };

    // `Object.create` (never a spread or `Object.assign` onto a clone) keeps the
    // inherited, frozen context members reachable while shadowing `report`.
    const proxy = Object.create(context, {
      report: {
        enumerable: true,
        value(...args: unknown[]) {
          const descriptor = normalizeReportArgs(args);
          const detection: Detection = { ...descriptor, options: context.options };
          const next = report ? report(detection, helpers) : undefined;

          if (!next) {
            originalReport(descriptor as Rule.ReportDescriptor);
            return;
          }

          // Only a fix the hook itself returned is range-checked; a fix merely
          // inherited from upstream is forwarded untouched.
          const merged = typeof next.fix === "function"
            ? {
                ...next,
                fix: guardAuthoredFix(next.fix, context.sourceCode.text.length, ruleLabel),
              }
            : next;

          originalReport(
            routeReportFix(mergeReport(descriptor, merged), next.fix !== undefined, autofix) as
              Rule.ReportDescriptor,
          );
        },
      },
    }) as Rule.RuleContext;

    return upstream.create(proxy);
  }

  return { meta, create, [TAILORING]: definition };
}
