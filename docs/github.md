# GitHub

How this repository uses issues, pull requests, milestones, and the project board (D206).

## Labels

The GitHub defaults are not used. Three groups:

| Group    | Labels                                                                                   |
| -------- | ---------------------------------------------------------------------------------------- |
| `type:`  | `feat`, `fix`, `perf`, `docs`, `test`, `chore`, `refactor`, `security`                   |
| `area:`  | `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, `ci`, `docs`                  |
| `needs:` | `decision`, `repro`, `design`                                                            |

`area:` follows the directories under `src/`. `ci` is workflows and `scripts/`. `docs` is `docs/` and the repository markdown.

Every issue and every pull request has exactly one `type:` label and at least one `area:` label. `needs:` is optional.

## Pull requests

- Title: `type(scope): summary`. The type is one of the `type:` names. The scope is a short lowercase name, such as `runtime`, `ci`, or `docs`.
- Branch: `pNN-short-name`, the same name as the plan row.
- The body ends with `Closes #N`.
- The pull request milestone is the milestone of that issue.
- The path labeler adds `area:` from the files that changed. Set `type:` yourself.

`.github/workflows/pr-meta.yml` checks the title, the closing line, one `type:` label, at least one `area:` label, and a milestone. It checks out the base branch and runs `scripts/pr-lint.ts`. It does not check out pull request code.

## Milestones

One milestone per release train (`0.5`). A patch keeps its number (`0.2.1`). The release workflow closes that milestone when the release ships.

## Project

The OKModel project has a Step field. The value is the plan id (`P64A`). Saved views are by status, by milestone, and a roadmap. Every item links the pull request that delivers it.

## Merges

Squash only. The branch is deleted on merge.

## Files

- Issue forms in `.github/ISSUE_TEMPLATE/` apply the `type:` label. Add the `area:` label that matches the area you selected. A vulnerability is a private advisory, not an issue (`../SECURITY.md`).
- `.github/labeler.yml` maps `src/contracts`, `src/dialects`, `src/adapters`, `src/runtime`, `src/tooling`, `scripts/`, `.github/`, and `docs/` onto `area:` labels.
- `.github/dependabot.yml` groups GitHub Actions updates and npm updates, weekly.
- `.github/release.yml` groups generated release notes by the `type:` label. The release workflow still publishes the notes from `changelog.md`.
