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
  const messages: Record<string, string> = {
    ...(upstreamMeta.messages ?? {}),
    ...(definition.meta?.messages ?? {}),
  };

  const meta: Rule.RuleMetaData = {
    ...upstreamMeta,
    ...(definition.meta ?? {}),
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
          originalReport(mergeReport(descriptor, next) as Rule.ReportDescriptor);
        },
      },
    }) as Rule.RuleContext;

    return upstream.create(proxy);
  }

  return { meta, create, [TAILORING]: definition };
}
