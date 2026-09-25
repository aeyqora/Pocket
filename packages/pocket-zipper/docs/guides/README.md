# Pocket Zipper guides

These guides take you from installing Pocket Zipper to gating your repository. They are
task-oriented: each one gets you to a working result and links out when you need the
reasoning behind it. The host-semantics reference lives separately in
[the CI reference](../ci/principles.md).

If you're new here, read them in this order:

1. **[Quick start](quick-start.md)** — install, configure, and run your first check.
2. **[Onboarding an existing codebase](onboarding-existing-codebase.md)** — grandfather
   the suppression debt you already have instead of blocking on it.
3. **[Handling a failure](handling-a-failure.md)** — read the report, then fix the code
   or authorize the suppression with an exception approved by your authorized approvers.
4. **[Exceptions: the registry format](exceptions.md)** — the record schema, when the
   registry is read and fails closed, `validate`, and the wizard.
5. **[Landing an exception](landing-an-exception.md)** — strict two-step vs combined
   landing, and what your git host can guarantee per path.
6. **[Pre-commit hook](pre-commit.md)** — get the verdict locally before you push.
7. **CI quick-starts** — put the authoritative gate in your pipeline:
   [GitHub Actions](ci/github.md), [GitLab CI/CD](ci/gitlab.md),
   [Bitbucket Cloud](ci/bitbucket.md).
8. **[Troubleshooting](troubleshooting.md)** — exit codes, error codes, and the
   problems people actually hit.

The registry-adjacent references: **[Config reference](config-reference.md)** for the
canonical default and every key, and **[Cleaning up unused exceptions](cleaning-up-unused-exceptions.md)**
for keeping the registry honest.

## The mental model

Pocket Zipper compares two trees, not two diffs:

- the **baseline** — the pre-change state, recomputed from git on every run; and
- the **proposed change** — the state you're about to land.

It inventories the ESLint suppression directives in each, reconciles them, and fails the
change only when it introduces **new debt**: a suppression with no continuous baseline
counterpart, or a **materially-changed** one — the *tomb* shape, where a directive is
text-identical to a baseline suppression but the baseline twin's guarded statement is
gone and this one is genuinely newly introduced. Moving a suppression, re-indenting it,
editing its justification, or rewriting the code it guards never counts as new — identity
is the directive itself, not its line number or the code beneath it.

There is no hosted service and no committed baseline manifest. The only inputs are your
installed ESLint, the `git` binary, and the committed policy files under `.pocket-zipper/`.

For the full inventory of what counts as a suppression — every directive shape plus the
config-level `off` — see [What the gate counts](suppression-types.md).