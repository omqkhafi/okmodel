---
name: okm-ship
description: >-
  Publishes an OKModel release. Do not run it after an ordinary pull request.
  `bun run bump release` fills an empty ## Unreleased from merged pull request
  titles and promotes it. `bun run bump next --publish` publishes a prerelease
  and does not touch the changelog. Use when the user asks to cut a release
  or a prerelease, not when finishing a feature, fix, or refactor.
---

# OKM Ship — release only

A pull request does not edit `changelog.md` and does not bump `package.json`. Finish the work, run `bun run verify:fast` once, push once, and `gh pr merge --auto --squash`. Then stop.

## When to run

- `bun run bump release` when publishing the release. An empty `## Unreleased` is filled from squash-merge subjects since the last `vX.Y.Z` tag, then promoted to `## vX.Y.Z — <date>`.
- `bun run bump next --publish` when publishing a prerelease. The version becomes `<next minor>-next.N`. The changelog stays as it is. Without `--publish` the command refuses.

`patch`, `minor`, `major`, and `--set` still promote the changelog. `--dry-run` prints the plan and writes nothing.

## Notes the release writes

Merged titles use `type(scope): summary`.

| Title | Changelog group |
| --- | --- |
| `feat` | `### ✨ Added` |
| `fix` | `### 🐛 Fixed` |
| `perf`, `refactor` | `### ♻️ Changed` |
| `security` | `### 🔒 Security` |
| `type(scope)!:` or a `BREAKING CHANGE:` body line | `### 💥 Breaking Changes` |
| `docs`, `test`, `chore` | omitted |

A group with eight or more bullets gains `####` headings in this order: `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, `docs`.

Hand-written bullets already under `## Unreleased` are kept. The generator fills the section only when it has none.

## Do not

- Append a changelog bullet on a feature pull request.
- Run `bun run bump next` to mark a pull request as shipped.
- Update `tests/fixtures/pack-contract.snap.json` or `docs/size-audit.md` as pull-request bookkeeping. The pack snapshot and the full size report run after merge.
