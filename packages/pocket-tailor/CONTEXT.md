# pocket-tailor

Wraps existing ESLint plugins so their rules' reports can be tailored: rewrite
messages (including internal doc links as plain text) and add fixes or
suggestions, while the upstream plugin keeps sole ownership of detection.

## Language

**Upstream plugin / upstream rule**:
The original plugin (and its rules) that gets wrapped. Detection always belongs to upstream.
_Avoid_: source plugin, base plugin, base rule

**Tailored rule**:
An upstream rule whose reports are reshaped by a tailoring module; it keeps the upstream rule ID.
_Avoid_: wrapped rule, overlay, shadow rule

**Tailoring**:
Reshaping the presentation of an upstream rule's reports for a specific codebase.
_Avoid_: customizing, forking

**Custom rule**:
A standalone rule with its own detection, written when tailoring is not enough. Not a pocket-tailor concept, but the explicit boundary of it.
_Avoid_: tailored rule

**Detection**:
What an upstream rule decides to flag: which nodes, under which conditions, under which message ids. Never added, removed, or re-ranked by this tool.
_Avoid_: detection logic, analysis

**Presentation**:
The message text and fix/suggestion content attached to a detection. The only part a tailored rule owns.
_Avoid_: output, report body

**Wrap**:
The operation `tailor()` performs: produce a new plugin object from an upstream plugin plus tailored rules, with every rule untouched except the tailored ones swapped in place.
_Avoid_: re-register, monkey-patch

**Report hook**:
The single entry point of a tailored rule (`report()`), invoked once per upstream detection; returns a modified report or nothing.
_Avoid_: create, handler

**Pass-through**:
Forwarding an upstream report unchanged when no tailoring applies to it. The default behavior of the report hook.
_Avoid_: fallback

**Fallback**:
An upstream rule serving its rule ID untouched because nothing tailors it. Happens when no tailored rule exists for that rule.
_Avoid_: pass-through

**Placement**:
Where a tailored rule module lives — repo-local, or exported from a package the repo already depends on. Location follows ownership: shared rules ship with the package that owns the components they reference.
_Avoid_: shared tailoring package, overlay package
