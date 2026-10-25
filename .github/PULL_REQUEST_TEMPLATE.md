<!--
HOW TO FILL THIS IN (for humans and agents)
- Keep every heading exactly as written. Tools parse these names.
- If a section doesn't apply, write "None". Never delete a section.
- Be specific: use file paths, file:line references, and exact commands. Avoid words like "various" or "some cleanup".
- These comments don't render on GitHub, so leave them in place.
-->

## Summary
<!-- 1–3 sentences: what changed and why. Lead with the outcome, not the process. -->

## Linked work
<!-- Issue, ticket, or PLAN.md task IDs, e.g. "Closes #123 · PLAN T3–T5". -->

## Changes
<!-- Group by area. One line per meaningful change: `path` — what and why. -->
- 

## Out of scope
<!-- What this PR deliberately does NOT do, so reviewers don't flag it and agents don't "finish" it. -->
- 

## Decisions & tradeoffs
<!-- Non-obvious choices, the alternatives you rejected, and why. Write "None" if it's straightforward. -->
- 

## Verification
<!-- Exact commands run and their results. A reviewer or agent should be able to rerun these verbatim. -->
```bash
# command → result
```
- Tests added/updated: <!-- paths, or "None: reason" -->
- Manual checks: <!-- steps + observed result, or "None" -->

## Risk & rollback
- **Risk:** <!-- low | medium | high --> — <!-- one line: what could break, and for whom -->
- **Deploy/config changes:** <!-- migrations, env vars, feature flags, permissions, metadata, or "None" -->
- **Rollback:** <!-- exact steps, e.g. "revert this PR" or "revert + run X" -->

## Reviewer focus
<!-- Where to look hardest, as `file:line` + a question or concern. Skip the obvious. -->
- 

## Follow-ups
<!-- Work this PR creates or defers. Link issues or PLAN task IDs where they exist. -->
- 

## Gate results
<!-- Filled by kit-merge-gate; leave "pending" when opening the PR. Auto-merge happens only if every row passes. -->
| Gate | Result | Detail |
|---|---|---|
| CI | pending | every check green, at least one ran |
| Verdict | pending | PR reviewer PASS |
| Diff size | pending | ≤ KIT_MAX_DIFF_LINES (.claude/kit.json), excluding PLAN/LESSONS/RUNLOG |
| Protected paths | pending | none of KIT_PROTECTED_REGEX touched |
| Spec integrity | pending | no `T<n>-spec:` test file modified |
| Head | pending | PR head is the reviewed commit |

---
- [ ] Every section filled or marked "None"
- [ ] Verification commands pass on this branch
- [ ] No secrets, debug code, or unrelated changes
