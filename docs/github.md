# GitHub

How this repository uses issues, pull requests, milestones, and the project board (D206).

## Labels

The GitHub defaults are not used. Three groups:

| Group    | Labels                                                                                   |
| -------- | ---------------------------------------------------------------------------------------- |
| `type:`  | `feat`, `fix`, `perf`, `docs`, `test`, `chore`, `refactor`, `security`                   |
| `area:`  | `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, `ci`, `docs`, `tenancy`, `grants` |
| `needs:` | `decision`, `repro`, `design`, `postgres`                                                |

`area:` follows the directories under `src/`. `ci` is workflows and `scripts/`. `docs` is `docs/` and the repository markdown. `tenancy` and `grants` are set on the issue. The path labeler does not add them: they are not directories under `src/` (D217).

Every issue and every pull request has exactly one `type:` label and at least one `area:` label. `needs:` is optional.

## Pull requests

- Title: `type(scope): summary`. The type is one of the `type:` names. The scope is a short lowercase name, such as `runtime`, `ci`, or `docs`.
- Branch: `pNN-short-name`, the same name as the plan row.
- The body ends with `Closes #N`.
- The pull request milestone is the milestone of that issue.
- The path labeler adds `area:` from the files that changed. Set `type:` yourself.

A pull request update starts one Actions run, `CI`. `label / paths` adds `area:` labels from the changed files. `lint / pull request` then checks the title, the closing line, one `type:` label, at least one `area:` label, and a milestone. It checks out the base branch and runs `scripts/pr-lint.ts`. Neither job checks out pull request code. A title edit, a label change, or a milestone change starts `pr-meta.yml` instead, which runs the same lint. A label added with `GITHUB_TOKEN` does not start another workflow.

A Dependabot pull request has no issue and no milestone, so `lint` skips the closing line and the milestone for `dependabot[bot]`. Its title and labels are still checked.

## Milestones

One milestone per release train (`0.5`). A patch keeps its number (`0.2.1`). The `github release` job in `.github/workflows/release.yml` closes that milestone when the release ships: `scripts/github-release.ts` creates the GitHub Release, then closes the milestone named by the version (`0.5.0` closes `0.5`, `0.2.1` closes `0.2.1`). A train whose `.0` was never published (0.2) keeps its milestone open until it is closed by hand.

## Project

The OKModel project has a Step field. The value is the plan id (`P64A`). Saved views are by status, by milestone, and a roadmap. Every item links the pull request that delivers it.

## Merges

Squash only. The branch is deleted on merge.

## Files

- Issue forms in `.github/ISSUE_TEMPLATE/` apply the `type:` label. Add the `area:` label that matches the area you selected. A vulnerability is a private advisory, not an issue (`../SECURITY.md`).
- `.github/labeler.yml` maps `src/contracts`, `src/dialects`, `src/adapters`, `src/runtime`, `src/tooling`, `scripts/`, `.github/`, and `docs/` onto `area:` labels.
- `.github/dependabot.yml` groups GitHub Actions updates and npm updates, weekly. Commits and titles start with `chore(deps)`, and each pull request gets `type: chore` and `area: ci`.
- `.github/release.yml` groups generated release notes by the `type:` label. The release workflow still publishes the notes from `changelog.md`.
