# OKModel repository rules

Operational rules for an agent in this repository. The rules in force are [docs/rules.md](docs/rules.md). Decisions are one file each under `docs/decisions/`. Start at [docs/decisions/INDEX.md](docs/decisions/INDEX.md). `CLAUDE.md` imports this file.

## Commands

Use Bun only. The version is `.bun-version`.

- `bun test tests/<name>.test.ts` runs one file.
- `bun run verify:fast` once, then push once. It checks format, lint, typecheck, layers, purity, docs, and the readme, then runs `bun test --changed` against the merge-base with `origin/main`.
- `bun run db:up` and `bun run db:down` start and stop the Postgres topology. `POSTGRES_VERSION` selects a major (default 17). Tested majors are 15, 16, 17, 18, and 19. Leave `OKM_PRIMARY_PORT=55432`, `OKM_REPLICA_A_PORT=55433`, and `OKM_REPLICA_B_PORT=55434` set when those ports are already in use. The primary URL is `postgres://okm:okm@127.0.0.1:55432/okm`.
- A Postgres test is `REQUIRE_DOCKER=1 bun test tests/<name>-pg.test.ts` with the topology up. Run the parent test for a worker. The parent spawns `bun tests/<name>.worker.ts`.
- `bun run decision -- D###` prints one decision. `bun run decision:next` prints the next free number. `bun run decisions:index` rewrites the index.
- When a rebase brings `docs/okmodel-decisions.md` back, check out main's copy, run `bun run decisions:split`, and delete the old file.

Do not run `bun run check` to finish a pull request. `gate / check` is the required status. Do not poll CI unless the prompt says to wait. Do not merge `main` unless the push is rejected for a real conflict. Do not push an empty commit.

## Merge flow

Agents never merge and never tag. Never publish, and never run `bun run bump release` or `bun run bump next --publish`, unless the prompt says so. Do not call the auto-merge API.

A pull request has no issue, no milestone, and no `Closes #N` line. One `type:` label and at least one `area:` label. Do not add `needs: postgres` unless a Postgres test is touched. That label does not start the suite. A pull request runs Postgres 18 when the diff touches `src/dialects`, `src/runtime`, or `src/tooling/migrate`.

Do not edit `changelog.md` or bump the version on a pull request.

## Workflow files

Edit a workflow only when the prompt allows it, or when a workflow bug blocks CI. That fix is the smallest change, its own commit, and named in the first line of the report.

## Quality

Every change ends with a quality pass on what you touched and its direct neighbors: one place for each rule, and the dead path from that step removed. Self-review against `docs/rules.md` before the report.

## Cursor Cloud

The image installs the Bun version from `.bun-version`. `site/` is not a workspace. Install it with `bun install --cwd site --frozen-lockfile`.

Boot starts Docker, then `bun run db:up` with the ports in Commands. The docs site listens on port 3333. If `docker info` fails, run `sudo service docker start`.

## Claude Code Cloud

- `gh` reaches GitHub through a proxy for this repository's REST API. GraphQL is refused, so `gh pr list`, `gh issue list`, and `gh project` fail. Use `gh api repos/omqkhafi/okmodel/...`.
- `sudo service docker start` does not start the daemon. Run `sudo dockerd` in the background, wait for `docker info`, then `bun run db:up` with the ports in Commands.
- A foreground command moves to the background after 2 minutes.

## Commits

Every commit message ends with exactly these two trailers and nothing else.

```
Signed-off-by: Omq Khafi <omqkhafi@gmail.com>
Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>
```
