---
name: okm-ship
description: >-
  Closes every OKModel implementation by appending notes to changelog.md
  under ## Unreleased. Use automatically after implementing a feature, fix,
  refactor, CLI change, dialect, adapter, runtime change, or any user-visible
  work — before saying the work is done, before commit, or when the user asks
  to ship, close out, or sync the changelog. Does not bump versions — that
  is `bun run bump`.
---

# OKM Ship — changelog after every implementation

Run this **before** you claim the work is done. A missing changelog note for user-visible work is a defect.

**Does not bump the version.** Notes for unfinished work go under `## Unreleased`. `bun run bump` promotes that section into `## vX.Y.Z — <date>` when you cut the next release.

## When to run

After any implementation that changes behavior, API surface, CLI, dialects, adapters, errors, or normative docs. Skip only for pure typo or format-only edits with no product impact.

## Workflow

```
Task:
- [ ] 1. Diff the change — list user-visible impact
- [ ] 2. Changelog — append under ## Unreleased → ### group + #### area
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

**Version bump is separate:**

```bash
bun run bump        # or: bun run bump -- patch|minor|major
# → bumps the root package.json version
# → renames ## Unreleased → ## v{next} — {today}
# → leaves a fresh empty ## Unreleased for the next cycle
```

Do **not** invent `## v{next}` yourself during okm-ship.

Rules:

- Groups only when non-empty, in order: `### ✨ Added` · `### 💥 Breaking Changes` · `### ♻️ Changed` · `### ⚠️ Deprecated` · `### 🔥 Removed` · `### 🐛 Fixed` · `### 🔒 Security`
- Large groups (8 or more bullets) add `####` area headings, only when that area has bullets, in order: `L0 contracts` · `L1 dialects` · `L2 adapters` · `L3 runtime` · `L4 tooling` · `Docs`
- Pick the area from where the change lives (do not invent new area names):

  | Change lives in…                         | `####` area  |
  | ---------------------------------------- | ------------ |
  | L0 contracts                             | L0 contracts |
  | L1 dialects                              | L1 dialects  |
  | L2 adapters                              | L2 adapters  |
  | L3 runtime                               | L3 runtime   |
  | CLI (`okm`), scripts, checks, CI         | L4 tooling   |
  | `docs/`                                  | Docs         |

- Small groups stay flat — no `####` until the group needs scanning.
- Bullets: user or product impact, not a file dump. Short sentences. Wrapped lines are fine.
- One idea per bullet.

## Done

- [ ] Notes under `## Unreleased` → matching `###` group and `####` area when the group is large
- [ ] Nothing appended under a released `## v…` section
- [ ] Version bump left to `bun run bump`
