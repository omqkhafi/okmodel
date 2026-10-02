---
name: okm-ship
description: >-
  Closes every OKModel implementation by appending notes to changelog.md
  under ## Unreleased, then running `bun run bump next`. Use automatically
  after implementing a feature, fix, refactor, CLI change, dialect, adapter,
  runtime change, or any user-visible work — before saying the work is done,
  before commit, or when the user asks to ship, close out, or sync the
  changelog. A gate prompt that releases runs `bun run bump release` instead.
---

# OKM Ship — changelog, then the pre-release bump

Run this **before** you claim the work is done. A missing changelog note for user-visible work is a defect.

Notes for unfinished work go under `## Unreleased`. Then run `bun run bump next`, which moves `package.json` to `<next release>-next.N` and leaves the changelog where it is. A gate prompt that cuts a release runs `bun run bump release` instead: that drops the suffix and promotes `## Unreleased` into `## vX.Y.Z — <date>`.

## When to run

After any implementation that changes behavior, API surface, CLI, dialects, adapters, errors, or normative docs. Skip only for pure typo or format-only edits with no product impact.

## Workflow

```
Task:
- [ ] 1. Diff the change — list user-visible impact
- [ ] 2. Changelog — append under ## Unreleased → ### group + #### area
- [ ] 3. Version — bun run bump next (gate prompts: bun run bump release)
```

### 1. Inventory impact

From the diff, list what a user or app author would notice. Map each item to:

| Impact                                | Changelog group    |
| ------------------------------------- | ------------------ |
| New capability / export / command     | `Added`            |
| Incompatible API, config, or behavior | `Breaking Changes` |
| Behavior or default change            | `Changed`          |
| Deprecation                           | `Deprecated`       |
| Removal                               | `Removed`          |
| Bug fix                               | `Fixed`            |
| Security-relevant                     | `Security`         |

If a note would invent an API the source does not support, stop and ask.

### 2. Changelog (`changelog.md`)

**Upcoming work → `## Unreleased`.** Never append to an already-shipped `## vX.Y.Z` section.

```text
If ## Unreleased is missing (right after the preamble, before the newest ## v…):
  Insert it.

Append bullets under the matching ### group and #### area
inside Unreleased (create the group / area if missing).
Do not dump a new bullet at the top of a large group.
```

Rules:

- Groups only when non-empty, in order: `### ✨ Added` · `### 💥 Breaking Changes` · `### ♻️ Changed` · `### ⚠️ Deprecated` · `### 🔥 Removed` · `### 🐛 Fixed` · `### 🔒 Security`
- Large groups (8 or more bullets) add `####` area headings, only when that area has bullets, in order: `contracts` · `dialects` · `adapters` · `runtime` · `tooling` · `docs`
- Pick the area from where the change lives (do not invent new area names):

  | Change lives in…                 | `####` area |
  | -------------------------------- | ----------- |
  | contracts                        | contracts   |
  | dialects                         | dialects    |
  | adapters                         | adapters    |
  | runtime                          | runtime     |
  | CLI (`okm`), scripts, checks, CI | tooling     |
  | `docs/`                          | docs        |

- Small groups stay flat — no `####` until the group needs scanning.
- Bullets: user or product impact, not a file dump. Short sentences. Wrapped lines are fine.
- One idea per bullet.

### 3. Version

After the notes are in `## Unreleased`:

```bash
bun run bump next
# → package.json becomes <next release>-next.N
# → changelog is left untouched
```

D115: hygiene finishes before a release bump. P09A is the cleanup after the M0 gate (spike leftovers, duplicated helpers, flaky tests, doc sync to draft 18, dependency audit, D127 budgets). A later gate (P17, P30, P44, P55, P66) does a lighter pass of that list, then runs:

```bash
bun run bump release
# → drops the -next.N suffix
# → renames ## Unreleased → ## v{version} — {today}
# → leaves a fresh empty ## Unreleased
```

Do **not** invent `## v{next}` yourself. `patch`, `minor`, `major`, and `--set` remain available; they still promote the changelog. `--dry-run` prints the plan and writes nothing.

## Engineering standards (D129)

Before the execution report, review the change against these rules. The report states the measurements.

- Built for performance, speed, lightness, and cold start, not only to pass tests.
- Nothing enters the runtime entry (`src/contracts/index.ts`) without need. Tooling stays out. No module-level computation. Lazy work. `sideEffects: false`.
- No duplicated logic: one helper, one place.
- Small, obvious public API. Clear names. Precise types. Actionable errors.
- No avoidable allocation or repeated work on hot paths.
- Report runtime entry size (minified and gzip), cold import, and any type-cost change.

## Done

- [ ] Notes under `## Unreleased` → matching `###` group and `####` area when the group is large
- [ ] Nothing appended under a released `## v…` section
- [ ] `bun run bump next` has run, or `bun run bump release` on a gate prompt
- [ ] Self-review against the engineering standards, with runtime entry size, cold import, and type-cost change in the report
