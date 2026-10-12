import type { Rule } from "eslint";
import { interpolate } from "./interpolate.js";
import {
  TAILORING,
  type Detection,
  type ReportHelpers,
  type ReportLocation,
  type TailoredReport,
  type TailoredRuleModule,
  type TailoringDefinition,
} from "./types.js";

/** A `context.report()` call normalized into one object. */
interface ReportDescriptor {
  messageId?: string;
  message?: string;
  data?: Record<string, unknown>;
  node?: Rule.Node;
  loc?: ReportLocation;
  fix?: Rule.ReportFixer | null;
  suggest?: Rule.SuggestionReportDescriptor[] | null;
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
 * Overlay a hook's report on the upstream detection. Fields the hook omits are
 * inherited from upstream (so location survives), then the descriptor is
 * normalized to what ESLint accepts:
 *
 * - location: `loc` wins over `node` in ESLint, so never carry both when the
 *   hook moved the report to a new node;
 * - message: exactly one of `message` / `messageId` may reach ESLint.
 */
function mergeReport(base: ReportDescriptor, next: TailoredReport): ReportDescriptor {
  const merged: ReportDescriptor = { ...base, ...next };

  if (next.node !== undefined) {
    delete merged.loc;
  } else if (next.loc !== undefined) {
    delete merged.node;
  }

  if (next.messageId !== undefined && next.messageId !== "") {
    delete merged.message;
  } else if (next.message !== undefined) {
    delete merged.messageId;
  }

  return merged;
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

  // Injecting a fix changes what ESLint's report-time guards require (ESLint
  // reads the *composed* meta, not upstream's):
  // - `fixable` only when the author opted into `--fix`; reuse upstream's fix
  //   type so a whitespace rule stays whitespace-fixable.
  // - `hasSuggestions` whenever an authored fix can become a suggestion, i.e.
  //   unless `autofix: true` (upstream's own suggestions are always kept).
  // Over-declaring is harmless: a rule that ends up emitting no fix/suggestion
  // is never rejected for a capability it did not use.
  const fixable = autofix ? (upstreamMeta.fixable ?? "code") : upstreamMeta.fixable;
  const hasSuggestions = autofix ? upstreamMeta.hasSuggestions : true;

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
          originalReport(
            routeReportFix(mergeReport(descriptor, next), next.fix !== undefined, autofix) as
              Rule.ReportDescriptor,
          );
        },
      },
    }) as Rule.RuleContext;

    return upstream.create(proxy);
  }

  return { meta, create, [TAILORING]: definition };
}
