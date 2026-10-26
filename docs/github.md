# GitHub

How this repository uses issues, pull requests, milestones, and the project board (D206).

## Labels

The GitHub defaults are not used. Three groups:

| Group    | Labels                                                                                   |
| -------- | ---------------------------------------------------------------------------------------- |
| `type:`  | `feat`, `fix`, `perf`, `docs`, `test`, `chore`, `refactor`, `security`                   |
| `area:`  | `contracts`, `dialects`, `adapters`, `runtime`, `tooling`, `ci`, `docs`, `tenancy`, `grants` |
| `needs:` | `decision`, `repro`, `design`                                                            |

`area:` follows the directories under `src/`. `ci` is workflows and `scripts/`. `docs` is `docs/` and the repository markdown. `tenancy` and `grants` are set on the issue. The path labeler does not add them: they are not directories under `src/` (D217).

Every issue has exactly one `type:` label and at least one `area:` label. A pull request receives the same labels from its title and its paths. `needs:` is optional and does not start a job.

## Pull requests

- Title: `type(scope): summary`. That is the only requirement. The type is one of the `type:` names. The scope is a short lowercase name, such as `runtime`, `ci`, or `docs`.
- Branch: `pNN-short-name`, the same name as the plan row.
- No closing line and no milestone.

A pull request update starts one Actions run, `CI`. `label / paths` adds `area:` from the changed files and `type:` from the title (`scripts/pr-labels.ts`). `lint / pull request` checks the title and nothing else (`scripts/pr-lint.ts`). A title edit starts `CI` again and `pr-meta.yml`. `pr-meta.yml` runs those two scripts from the base branch. A body edit does not replace `gate / check`; that job repeats the last conclusion for the commit. A label added with `GITHUB_TOKEN` does not start another workflow.

`gate / check` is the required status. It always runs (`if: always()`). It needs format, lint, typecheck, the build, tests for files changed since the merge base, the runtime-entry size ceiling, the title lint, and the path labels. Postgres 18 (four shards and the pooler proof) runs when the diff touches `src/dialects`, `src/runtime`, or `src/tooling/migrate`. A skipped suite is a pass only when those paths are absent. A failure still fails. Site tests run inside the gate when the diff touches `src/tooling` or `src/dialects`, because that is where CLI output is produced. The Site workflow is not a required check. The pack contract runs inside the gate when the diff touches `src/`, `scripts/`, or `package.json`, and a drift names `bun ./scripts/pack-contract.ts --update`. One job builds `dist` and uploads it. The suite and the pack contract download it. The cycle plan is [ci-and-test-cycle-plan.md](ci-and-test-cycle-plan.md).

A push to `main` and the nightly run (03:00 UTC) run everything else: the full test matrix, type cost, attest, portable runtimes, the temporal matrix, package checks, Windows, the size report, Postgres 15 through 18, and the tarball on those majors. A failure opens or updates one issue, `CI failed after merge`. Release uses the same suite and tarball workflows and builds `dist` inside the shard when no artifact was passed.

A Dependabot pull request is linted like any other. Its title starts with `chore(deps)`, and Dependabot still applies `type: chore` and `area: ci`.

## Milestones

One milestone per release train (`0.5`). A patch keeps its number (`0.2.1`). The `github release` job in `.github/workflows/release.yml` closes that milestone when the release ships: `scripts/github-release.ts` creates the GitHub Release, then closes the milestone named by the version (`0.5.0` closes `0.5`, `0.2.1` closes `0.2.1`). A train whose `.0` was never published (0.2) keeps its milestone open until it is closed by hand.

## Project

The OKModel project has a Step field. The value is the plan id (`P64A`). Saved views are by status, by milestone, and a roadmap. Every item links the pull request that delivers it.

## Merges

Squash only, with auto-merge. The branch does not have to be up to date with `main`. The branch is deleted on merge.

## Files

- Issue forms in `.github/ISSUE_TEMPLATE/` apply the `type:` label. Add the `area:` label that matches the area you selected. A vulnerability is a private advisory, not an issue (`../SECURITY.md`).
- `.github/labeler.yml` maps `src/contracts`, `src/dialects`, `src/adapters`, `src/runtime`, `src/tooling`, `scripts/`, `.github/`, and `docs/` onto `area:` labels.
- `.github/dependabot.yml` groups GitHub Actions updates and npm updates, weekly. Commits and titles start with `chore(deps)`, and each pull request gets `type: chore` and `area: ci`.
- `.github/release.yml` groups generated release notes by the `type:` label. The release workflow still publishes the notes from `changelog.md`.
