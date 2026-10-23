# Reference

The command surface, the config surface, the report schema, and the package's exported
API. For the guided flow, see [the wizard guide](README.md); for narrative config and
action explanations, see [Configuration](configuration.md) and [Actions](actions.md).

## Command synopsis

```text
pocket-comb                     # TTY: wizard, choose the action
pocket-comb <action>            # TTY: wizard, action preselected
pocket-comb <action> [flags]    # flag-driven; no prompts on a non-TTY
```

```text
Actions:
  suppress | fix | remove | replace | cleanup | inventory
```

The guides use the wizard. This page is the full non-interactive surface, plus the rules
the wizard follows.

## Wizard

On a terminal, Pocket Comb starts an interactive session. It asks only for gaps and
pre-fills what it can infer. You do not need any flags to use it.

```sh
npx pocket-comb                 # choose everything in the wizard
npx pocket-comb suppress        # skip only the action prompt
```

### Prompt reference

| Prompt | Appears when | Default / pre-fill |
|---|---|---|
| **Which action?** | No action argument | None; select one of six |
| **Action config** | No `--config` | The first `pocket-comb.config.{js,mjs,cjs,json}` in the cwd, else the cwd |
| **Target directory** | No `--target` and no `settings.target` | The resolved target root, usually the cwd |
| **Rule to rename (from)** | `replace`, and no flags and no `settings.replace` | None |
| **New rule name (to)** | `replace`, and no flags and no `settings.replace` | None |
| **Apply changes? (No = dry run)** | Mutating action, and no `--dry-run` / `--apply` | `No` (dry run) |
| **Report format** | No report flag and no `settings.report` | `html` |
| **Report output** | No report flag and no `settings.report` | `pocket-comb-report.<ext>` in the cwd |
| **Next** | After an interactive dry run | None; Apply now / Restart / Abort |

`inventory` never asks the apply question and never offers **Next**; it is read-only.

### Session order

1. Action, config, target, and (for `replace`) the rename pair.
2. The dry-run/apply question for a mutating action.
3. The run, spinner, impact summary, and completion line.
4. The report format and output prompts, unless already answered.
5. The **Next** menu after an interactive dry run.

The report prompt is deliberately late: it appears after the impact summary, so you can
review the run before choosing where the report goes.

### Next menu

| Choice | Effect |
|---|---|
| **Apply now** | Re-runs the same action in apply mode. The report answer is reused; every action is idempotent. |
| **Restart** | Returns to the questions with the original invocation. An action argument keeps the action preselected. |
| **Abort** | Leaves the target untouched and returns the dry-run exit code. |

Cancelling at a pre-run prompt exits `0` without running. Cancelling at a report prompt
declines the report and keeps the run's exit code; it also skips the **Next** menu.
Cancelling at **Next** keeps the dry-run result and never applies.

An explicit `--dry-run` is terminal: it prints the impact and exits without the **Next**
menu.

### What skips a prompt

- `--config` skips the config prompt.
- An action argument skips the action prompt.
- `--target` or `settings.target` skips the target prompt.
- `--from` / `--to` or `settings.replace` skips the two rename prompts.
- `--dry-run` or `--apply` skips the apply question.
- `--format`, `--out`, `--no-report`, or `settings.report` skips the report prompts.
- `inventory` skips the apply question and **Next** menu.

A non-interactive run never enters the wizard. Anything required and missing is exit `2`;
for example, `replace` without a pair is an error rather than a prompt.

## Actions and their flags

| Action | Action-specific flags | Mutating |
|---|---|---|
| `suppress` | `--reason <text>`, `--fix-first`, `--reuse-blocks` | Yes |
| `fix` | none | Yes |
| `remove` | none | Yes |
| `replace` | `--from <rule>` and `--to <rule>` | Yes |
| `cleanup` | none | Yes |
| `inventory` | none | No; rejects `--dry-run` / `--apply` |

Everything else in the flag table applies to every action.

## Flags

These are the full options. Any flag that answers a wizard question also skips that
prompt. A non-interactive run uses flags, settings, and defaults only.

### Shared flags

| Flag | Value | Default | Meaning |
|---|---|---|---|
| `-c`, `--config <path>` | path | auto-detected | Action config. Relative paths resolve against the cwd. |
| `-t`, `--target <path\|glob>` | path or glob | cwd | Target root. `settings["pocket-comb"].target` fills it when the flag is absent. |
| `--dry-run` | none | yes, non-interactive | Report impact and write nothing. Mutually exclusive with `--apply`. |
| `--apply` | none | no | Write the action's edits. Mutually exclusive with `--dry-run`. |
| `--format <fmt>` | `csv`, `json`, `html` | `html` | Report format. |
| `--out <path\|->` | path or `-` | `pocket-comb-report.<ext>` in cwd | Report destination. `-` streams to stdout. |
| `--no-report` | none | off | Skip the report. |
| `--workers <n>` | positive integer | `ceil(cores x 0.75)`, min 1 | Worker pool size. |
| `--serial` | none | off | Run in one in-process instance, no pool. Takes precedence over `--workers`. |
| `--batch-size <n>` | positive integer | `16` | Files per task. |
| `--extensions <csv>` | comma-separated extensions | `.js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx` | Discovery filter. Replaces the default list wholesale. |
| `--help`, `-h` | none | - | Print usage and exit `0`. |
| `--version`, `-V` | none | - | Print the version and exit `0`. |

Flag values may be written as `--flag value` or `--flag=value`. A boolean flag given a
value is a usage error.

### `suppress` flags

| Flag | Value | Meaning |
|---|---|---|
| `--reason <text>` | text | Append ` -- <text>` to **inserted** directives only. |
| `--fix-first` | none | Run the autofix phase, re-lint, then suppress the remainder. |
| `--reuse-blocks` | none | Prepend into the nearest enclosing block-open or file-level directive instead of inserting a minimal-span directive. |

These three flags are rejected on every other action.

**Directive spelling.** `suppress` parses the file with the action config's configured
parser and chooses the inserted comment style from the violation line's syntax. Ordinary
JS/TS code and JSX attribute lines get `// eslint-disable-next-line <rules>`; JSX children
get `{/* eslint-disable-next-line <rules> */}`. A line inside a template literal, string,
or comment — or a file whose parser cannot be resolved or parsed — is reported as not
actionable and is never edited. Existing directives keep their own spelling on prepend:
`//`, `/* */`, `{/* */}`, and `{ /* */ }` all round-trip unchanged.

### `replace` flags

| Flag | Value | Meaning |
|---|---|---|
| `--from <rule>` | rule token or namespace prefix | Source to rename. A trailing `/` makes it a prefix rename. Requires `--to`. |
| `--to <rule>` | rule token or namespace prefix | Destination. Requires `--from`. |

`--from` and `--to` must be given together. They are rejected on every other action. A
missing pair can come from `settings["pocket-comb"].replace` instead.

### Flag applicability errors

These are usage errors (exit `2`):

- `--from` or `--to` on an action other than `replace`.
- `--reason`, `--fix-first`, or `--reuse-blocks` on an action other than `suppress`.
- `--dry-run` or `--apply` on `inventory`.
- `--dry-run` together with `--apply`.
- Only one of `--from` / `--to`.
- A non-positive `--workers` or `--batch-size`.
- An empty `--extensions` list.
- An unknown action, flag, or invalid `--format` value.

## Precedence

General rule: **flags first, then settings, then the wizard for anything still open,
then defaults.** The wizard only prompts for gaps, so it never overrides a setting.

| Value | Order |
|---|---|
| Config file | `--config` -> auto-detected `pocket-comb.config.{js,mjs,cjs,json}` -> wizard -> exit `2` |
| Target | `--target` -> `settings.target` -> wizard -> cwd |
| Mode | `--dry-run` / `--apply` -> wizard -> dry run |
| Replace pair | `--from` / `--to` -> `settings.replace` -> wizard -> exit `2` (non-interactive) |
| Report format | `--format` -> `settings.report.format` -> wizard -> `html` |
| Report destination | `--out` -> `settings.report.out` -> wizard -> `pocket-comb-report.<ext>` |
| Workers | `--workers` / `--serial` -> `ceil(cores x 0.75)`, min 1 |
| Batch size | `--batch-size` -> `16` |
| Extensions | `--extensions` -> built-in default list |

`--no-report` skips the report regardless of any format or destination.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success: an apply completed, a dry run found no impact, a census completed, `--help` / `--version`, or the wizard was cancelled before running. |
| `1` | Dry run with impact. For `suppress`, `remove`, `replace`, and `cleanup`: any edit. For `fix`: any file that would be fixed. |
| `2` | Operational or usage error: config missing or unloadable, no files matched, invalid input, incompatible flags, or an unrecoverable worker failure. |

`inventory` never returns `1` on a successful census. It returns `2` for the same
operational failures as every other action.

The exit probe measures **edits** for `suppress`, `remove`, `replace`, and `cleanup`, and
**files touched** for `fix`. A dry run that only prints not-actionable notes has no edits,
so it exits `0`.

Dry-run exit `1` is the CI probe. There is no separate `check` subcommand.

## Config keys

The action config is a standard ESLint flat config. Pocket Comb consumes these parts:

| Area | Meaning |
|---|---|
| `rules` | The action's rule set. Any severity greater than zero is actionable; `"off"` / `0` is excluded. |
| `files`, `ignores` | Scope and ESLint config coverage. A file no object covers is dropped as unconfigured. |
| `languageOptions` | Parser and language wiring. |
| `settings["pocket-comb"].target` | Target root; relative paths resolve against the config file's directory. |
| `settings["pocket-comb"].replace` | Default `{ from, to }` pair for `replace`. |
| `settings["pocket-comb"].report` | Default `{ format, out }` for reports. |

Supported file names: `pocket-comb.config.js`, `.mjs`, `.cjs`, `.json`. A `.ts` config
is not auto-detected; pass it with `--config`.

Full details, path rules, and recipes: [Configuration](configuration.md).

## Discovery

`--target` accepts a directory or a glob.

- A directory is walked recursively.
- A glob is planned from its longest literal prefix, then matched.
- `.gitignore` is honored: ancestor files up to the repository root, plus nested files
  inside the target. Deeper rules win.
- Hardcoded skips: `node_modules`, `.git`, `dist`, and dot-directories.
- `--extensions` filters by suffix (case-insensitive; a leading dot is optional in the
  flag value).
- Paths are absolute and sorted.

ESLint then applies the action config's `files` / `ignores` to each explicit file. A file
that ESLint drops is classified as `ignored`, `unconfigured`, or `external`, and counted
in `meta.counts.dropped`.

If discovery finds no files at all, the action exits `2` with `no files matched under
<target>`.

## Human output

Mutating actions print an impact summary, any action-specific notes, then a completion
line. The report comes last.

### Impact summary

```text
Impact: 3 files would change, 12 edits (9 inserted, 3 prepended)
  by type: insert 9, prepend 3
  by rule: no-console 8, no-unused-vars 4
```

- `would change` on a dry run; `changed` on an apply run.
- The edit count is the ledger's count, one record per `(edit, rule)`.
- `fix` runs add `, N fixed` and show `fix N` in the by-type line.
- Empty rollups print `none`.

### Completion line

```text
Done: 3 files touched, 12 edits (9 inserted, 3 prepended) — 1.2s
```

`fix` adds `, N fixed` when files were fixed. For `remove`, `replace`, and `cleanup`,
the inserted/prepended slots remain and normally read `0 inserted, 0 prepended`; their
work appears in the by-type line and the report.

### Census line

```text
Census: 3 directives in 12 files (next-line 2, block 1) — 0.0s
```

`inventory` has no impact summary and no completion line; it prints the census summary.
The file count is every discovered and scanned file, including files with no directives.

### Not-actionable notes

```text
Not actionable: 2 bare directives (no rule list)
  src/a.js:3 next-line // eslint-disable-next-line
  src/b.js:10 block /* eslint-disable */
```

When every note is a bare directive, that exact line is printed. When a run also has
context skips (a violation inside a template literal, string, comment, or an unknown
syntax position), the header becomes `Not actionable: N items` and each row carries its
reason:

```text
Not actionable: 2 items
  src/a.js:3 next-line // eslint-disable-next-line — bare directive (no rule list)
  src/b.js:7   ${value} — inside a template literal
```

`suppress` reports bare guards it left untouched and violation lines with no safe
insertion point. `remove` and `cleanup` report bare directives they could not scope. The
list is emitted after the impact summary.

### Replace hint

```text
Next: run cleanup to prune now-unused directives
```

Printed when `replace` made at least one rename. The same text appears as `hint` in the
JSON/HTML report.

### Report-to-stdout behavior

With `--out -`, the report is streamed to stdout and the run's impact, completion, census,
not-actionable, and hint lines move to stderr so a piped report stays parseable. When the
wizard is active, its pre-run prompts still use the terminal.

## Reports

| Format | Default name | Shape |
|---|---|---|
| `html` | `pocket-comb-report.html` | Self-contained page with inline CSS, summary, rollups, and per-file drill-down. No external assets or required JavaScript. |
| `json` | `pocket-comb-report.json` | Canonical schema: `meta`, optional `hint`, `edits`, `byRule`, `byForm`, `byFile`. Censuses use `meta`, `totals`, `byFile`. |
| `csv` | `pocket-comb-report.csv` | Flat ledger, or the census table. RFC-4180 quoting. |

Resolution:

- `--format` picks the format; default `html`.
- `--out` picks the destination; a relative path resolves against the cwd; `-` is
  stdout.
- Without `--out`, the name is `pocket-comb-report.<ext>` in the cwd.
- The destination file is clobbered per run.
- `--no-report` disables emission.
- On an unrecoverable worker failure, the partial ledger is written even with
  `--no-report`. This preserves what the run completed before the failure.

### Run report JSON

```json
{
  "meta": {
    "tool": "pocket-comb",
    "version": "0.2.0",
    "action": "suppress",
    "configPath": "/repo/pocket-comb.config.js",
    "configHash": "sha256-hex",
    "target": "/repo",
    "startedAt": "2026-10-20T12:00:00.000Z",
    "durationMs": 1234,
    "dryRun": true,
    "workers": 6,
    "counts": {
      "discovered": 120,
      "linted": 118,
      "dropped": 2,
      "touched": 3
    }
  },
  "hint": "optional follow-on text",
  "edits": [
    {
      "file": "/repo/src/a.js",
      "line": 4,
      "rule": "no-console",
      "editType": "insert",
      "form": "next-line",
      "after": "// eslint-disable-next-line no-console"
    }
  ],
  "byRule": [{ "rule": "no-console", "count": 1 }],
  "byForm": [{ "form": "next-line", "count": 1 }],
  "byFile": [{ "file": "/repo/src/a.js", "count": 1 }]
}
```

`hint` is omitted when the action has no follow-on guidance.

`meta.counts`:

| Field | Meaning |
|---|---|
| `discovered` | Files found by discovery. |
| `linted` | Files whose lint result reached the action. |
| `dropped` | Files ESLint filtered out (ignored, unconfigured, external). |
| `touched` | Files with at least one edit. |

`edits` grain and values:

| Field | Meaning |
|---|---|
| `file` | Absolute path. |
| `line` | 1-based line the edit anchors to. |
| `rule` | Rule token. `fix` uses `(autofix)`; a deleted bare directive uses `*`. |
| `editType` | `insert`, `prepend`, `strip`, `rename`, `prune`, or `fix`. |
| `form` | `next-line`, `line`, `block`, `file-level`, or `null` for autofix. |
| `before` | Directive line text before the edit. Absent for an insert. |
| `after` | Directive line text after the edit. Absent for a whole-line delete. |

One record is emitted per `(edit, rule)`. A directive that adds two rules produces two
records sharing the same line, form, before, and after. A `fix` edit produces one record
per changed file.

Rollups:

- `byRule`: alphabetical by rule.
- `byForm`: canonical order `next-line`, `line`, `block`, `file-level`; forms with no
  edits are omitted.
- `byFile`: alphabetical by path.

### Census JSON

```json
{
  "meta": { "...": "same metadata shape" },
  "totals": [
    { "form": "next-line", "rule": "no-console", "count": 2 },
    { "form": "next-line", "rule": null, "count": 1 },
    { "form": "block", "rule": "no-console", "count": 1 }
  ],
  "byFile": [{ "file": "/repo/src/a.js", "count": 3 }]
}
```

- `totals` counts **rule incidences**. A directive naming two rules contributes two
  entries. A bare directive contributes one entry with `rule: null`.
- `byFile` counts **directives**, one per disable comment.
- `eslint-enable` is excluded from both.
- Ordering: form canonical, then rule alphabetical with `null` last; files alphabetical.
- A census report has no `edits`, `byRule`, `byForm`, or `hint`.

### CSV

Run report columns:

```text
file,line,rule,editType,form,before,after
```

Census columns:

```text
form,rule,count
```

A bare census entry has an empty `rule` field. Fields containing a comma, quote, CR, or LF
are quoted per RFC 4180.

### HTML

One self-contained file. It shows the run summary, by-rule / by-form / by-file rollups,
and a `<details>` drill-down per file with the full ledger. Census pages use the same
frame with the census totals instead.

## Programmatic API

The package exposes its root module. The CLI is the product surface; the exports below
are for embedding or scripting against the same pipeline.

```js
import { main, loadConfig, discover, createIsolatedESLint } from "pocket-comb";
```

### Entry and CLI

| Export | Signature | Purpose |
|---|---|---|
| `main` | `(argv?: string[], io?: CommandIo, deps?: MainDeps) => Promise<number>` | Run the CLI with injectable IO; returns the exit code. |
| `processIo` | `() => CommandIo` | The production IO seam (`cwd`, streams, `tty`). |
| `parseArgs` | `(argv: string[]) => ParseResult` | Parse an invocation. |
| `usage` | `(action?: Action \| null) => string` | The usage text. |
| `VERSION` | `string` | Package version. |
| `ACTIONS` | `readonly Action[]` | The six action names. |
| `REPORT_FORMATS` | `readonly ReportFormat[]` | `csv`, `json`, `html`. |
| `EDIT_TYPES` | `readonly EditType[]` | Canonical edit-type order. |
| `BARE_RULE` | `"*"` | Ledger marker for a deleted bare directive. |

### Config

| Export | Signature | Purpose |
|---|---|---|
| `loadConfig` | `(options: LoadConfigOptions) => Promise<LoadedConfig>` | Resolve the config, settings, rule set, target, hash, and precedence. |
| `autoDetectConfig` | `(cwd: string) => string \| undefined` | Find the convention file. |
| `isActionableRule` | `(severity: unknown) => boolean` | Severity membership (`> 0`, `warn`, `error`). |

### Discovery and linting

| Export | Signature | Purpose |
|---|---|---|
| `discover` | `(options: DiscoverOptions) => Promise<DiscoverResult>` | Tool-owned file walk. |
| `DEFAULT_EXTENSIONS` | `readonly string[]` | The built-in extension list. |
| `createIsolatedESLint` | `(options: CreateIsolatedESLintOptions) => ESLint` | Construct the standalone instance. |
| `lintFiles` | `(eslint: ESLint, files: string[]) => Promise<LintFilesResult>` | Lint an explicit file list, classify drops, skip fatal parses. |

### Engine

| Export | Signature | Purpose |
|---|---|---|
| `runActionForFile` | `(options: RunActionForFileOptions) => RunActionResult` | Plan and apply one action to one file's text. `suppress` needs `options.syntax` for inserts; without it, inserts are reported as not actionable rather than guessed. |
| `runBatch` | `(eslint: ESLint, files: string[], options: RunBatchOptions) => Promise<RunBatchResult>` | Lint and run one batch. Builds the suppress syntax resolver from the resolved parser. |
| `scanSuppressFile` | `(lines: readonly string[], messages: readonly LintMessage[]) => SuppressTarget[]` | The lazy suppress guard scan. |
| `planSuppressEdits` | `(targets: readonly SuppressTarget[], params: SuppressParams, lines?: readonly string[], syntax?: LineSyntaxResolver) => SuppressPlan` | Turn targets into insert/prepend edits, choosing the spelling from `syntax`. |
| `createLineSyntaxResolver` | `(text: string, languageOptions: SyntaxLanguageOptions \| undefined, filePath: string) => LineSyntaxResolver` | Lazy, parser-backed insertion-context classifier. |
| `edgesFor` | `(context: InsertContext) => CommentEdges` | The `//` or `{/* */}` spelling for a context. |
| `unavailableSyntax` | `(reason: string) => LineSyntaxResolver` | A resolver that refuses every insert with a reason. |
| `applySuppressEdits` | `(lines: string[], edits: readonly PlannedEdit[]) => void` | Apply planned edits bottom-up. |
| `findEnclosingBlockGuard` | `(lines: readonly string[], violationLine: number) => BlockGuard \| undefined` | The `--reuse-blocks` lookup. |
| `splitRuleList` | `(rest: string) => RuleList` | Split a directive tail into rules and description. |
| `ledgerRecordsForEdit` | `(file: string, edit: PlannedEdit) => EditRecord[]` | One ledger record per added rule. |
| `renameRule` | `(rule: string, pair: ReplaceParams) => string \| null` | Exact or prefix rename. |
| `isPrefixRename` | `(from: string) => boolean` | Whether a pair is a namespace rewrite. |
| `parseUnusedDirectiveMessage` | `(message: LintMessage) => UnusedDirectiveMessage \| null` | Parse ESLint's unused-directive text. |

### Directive scan and census

| Export | Signature | Purpose |
|---|---|---|
| `scanDirectives` | `(lines: readonly string[]) => ScannedDirective[]` | Full-file scan across all four forms and every comment spelling (`//`, `/* */`, `{/* */}`, `{ /* */ }`). |
| `formatDirective` | `(directive: ScannedDirective, rules: readonly string[]) => string` | Re-render a directive preserving form, exact spelling, description, prefix, and CRLF. |
| `directiveName` | `(directive: ScannedDirective) => string` | The directive keyword for a form. |
| `censusFiles` | `(files: readonly CensusInput[]) => CensusResult` | Aggregate per-file scans into census totals. |
| `censusFileScan` | `(lines: readonly string[]) => CensusFileScan` | One file's census entries. |

### Ledger and reports

| Export | Signature | Purpose |
|---|---|---|
| `buildRunReport` | `(meta: RunMeta, edits: readonly EditRecord[], hint?: string) => RunReport` | Assemble the canonical report. |
| `orderEdits` | `(edits: readonly EditRecord[]) => EditRecord[]` | Deterministic ledger order. |
| `rollupByRule` | `(edits: readonly EditRecord[]) => RuleCount[]` | Per-rule rollup. |
| `rollupByForm` | `(edits: readonly EditRecord[]) => FormCount[]` | Per-form rollup. |
| `rollupByFile` | `(edits: readonly EditRecord[]) => FileCount[]` | Per-file rollup. |
| `DIRECTIVE_FORMS` | `readonly DirectiveForm[]` | Canonical form order. |
| `resolveReportOptions` | `(input: ReportOptionsInput) => ResolvedReportOptions` | Precedence and default-path resolution. |
| `DEFAULT_REPORT_BASENAME` | `"pocket-comb-report"` | Stable default basename; the extension is chosen per format. |
| `defaultReportPath` | `(cwd: string, format: ReportFormat) => string` | `pocket-comb-report.<ext>`. |
| `renderReport` | `(data: ReportData, format: ReportFormat) => string` | Render in one of the three formats. |
| `renderJson` | `(report: ReportData, pretty?: boolean) => string` | Canonical JSON. |
| `renderCsv` | `(report: ReportData) => string` | Flat ledger or census CSV. |
| `renderHtml` | `(report: ReportData) => string` | Self-contained HTML. |
| `emitReport` | `(options: EmitReportOptions) => EmitReportResult` | Write a file or stdout. |
| `isCensusReport` | `(data: ReportData) => data is CensusReport` | Structural discriminator. |

### Pool

| Export | Signature | Purpose |
|---|---|---|
| `runPool` | `(options: RunPoolOptions) => Promise<RunPoolResult>` | Run the worker pool or serial path. |
| `defaultWorkerCount` | `(cores?: number) => number` | `ceil(cores x 0.75)`, min 1. |
| `DEFAULT_BATCH_SIZE` | `16` | Default files per task. |
| `PoolRecoveryError` | class | Unrecoverable worker failure carrying partial results. |

### Actions and UI

| Export | Signature | Purpose |
|---|---|---|
| `runAction` | `(action: Action, context: ActionContext) => Promise<number>` | Dispatch a wired action. |
| `createSpinner` | `(options?: SpinnerOptions) => Spinner` | Hand-rolled main-thread spinner. |
| `summarizeImpact` | `(outcomes) => ImpactSummary` | Build the impact summary. |
| `summarizeRun` | `(outcomes, elapsedMs) => CompletionSummary` | Build the completion summary. |
| `formatImpactSummary` | `(summary: ImpactSummary, dryRun: boolean) => string` | Impact text. |
| `formatCompletion` | `(summary: CompletionSummary) => string` | Completion text. |
| `formatCensusSummary` | `(summary: CensusSummary) => string` | Census text. |
| `writeImpactSummary` | `(output, summary, dryRun) => void` | Write the impact block. |
| `writeCompletion` | `(output, summary) => void` | Write the completion line. |
| `writeCensusSummary` | `(output, summary) => void` | Write the census line. |
| `writeNotActionable` | `(output, cwd, outcomes) => void` | Write the not-actionable notes. |

### Wizard

| Export | Signature | Purpose |
|---|---|---|
| `runWizard` | `(deps: WizardDeps) => Promise<number>` | The interactive gap-filling session. |
| `createClackPrompter` | `(io: CommandIo) => Prompter` | The `@clack/prompts` implementation. |
| `isCancelled` | `(value: Answer<T>) => value is CancelSignal` | Cancellation guard. |
| `WIZARD_CANCEL` | unique symbol | The cancel sentinel. |

### Errors

| Export | Meaning |
|---|---|
| `OperationalError` | Base class for exit-`2` failures. |
| `UsageError` | Invalid CLI input. |
| `ConfigError` | Config missing, unreadable, unloadable, or malformed. |
| `NotImplementedError` | Reserved for a verb without a wired command. |
| `isOperationalError` | Type guard. |

The exported TypeScript types are listed in `dist/index.d.ts`. They include
`ParsedInvocation`, `LoadedConfig`, `PocketCombSettings`, `Action`, `ReportFormat`,
`DirectiveForm`, `EditRecord`, `RunReport`, `CensusReport`, `RunMeta`, `ActionContext`,
`CommandIo`, and the engine/report/pool option types.

## Requirements and compatibility

| Item | Requirement |
|---|---|
| Node.js | 20.12 or newer |
| ESLint | 9.34 or newer, flat config only |
| Module system | ESM (`"type": "module"`) |
| Config formats | `.js`, `.mjs`, `.cjs`, `.json`; `.ts` with an explicit `--config` and a TypeScript-capable runtime |
| Optional peer | None beyond ESLint |

Pocket Comb deliberately does not read legacy `.eslintrc` files and does not use ESLint's
file-based bulk suppression format (`eslint-suppressions.json`). A stray suppressions
file in the target cannot mask violations.

## Common failures

| Symptom | Cause and fix |
|---|---|
| `no action config found` | No `--config` and no convention file in the cwd. Create one or pass `--config`. |
| `no files matched under <target>` | The target is empty, wrong, or excluded by `--extensions`. Check `--target`. |
| `.ts` files are counted as dropped | The action config has no `files` coverage or no parser for them. Add `files: ["**/*.ts"]` and `languageOptions.parser`. |
| `replace needs a rule pair` | Pass `--from` and `--to`, or set `settings["pocket-comb"].replace`. |
| `flag '--reason' only applies to suppress` | Use action-specific flags only on their action. |
| `flag '--apply' does not apply to inventory` | `inventory` is read-only; drop the flag. |
| A run finds fewer files than expected | Check `.gitignore`, hardcoded skips (`node_modules`, `.git`, `dist`, dot-directories), and `--extensions`. |
| A parse error appears in the output | The file was skipped, not crashed on. Fix the syntax or exclude the file with `ignores`. |

## Related

- [Configuration](configuration.md)
- [Actions](actions.md)
- [Examples](examples.md)
