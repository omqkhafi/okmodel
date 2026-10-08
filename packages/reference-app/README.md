# Reference app

A small project tracker built on OKModel's public entry points (`okmodel/pg`, `okmodel/fn`, `okmodel/view`, `okmodel/tenancy`, `okmodel/traits`, `okmodel/migrate`, `okmodel/testing`, `okmodel/pg/postgresjs`). It is private and not published. CI runs it as the end-to-end proof (D207).

- `src/schema.ts`: workspaces (tenants), members, projects, tasks, comments; a `task_status` enum, the `task_is_open` function, and the `active_projects` and `open_tasks` views.
- `src/db.ts`: one primary, or a primary with named replicas.
- `src/use-cases.ts`: create a workspace, add a project and tasks, comment, move a task, archive and restore a project, a board page, and a report read from a replica.
- `okmodel.config.ts`: targets from the environment (`DATABASE_URL`, `PREVIEW_DATABASE_URL`, `REHEARSAL_DATABASE_URL`, `PRODUCTION_DATABASE_URL`, which is protected), roles, and a backfill batch of 500.
- `migrations/`: `0001_init`, `0002_public_id` (expand with a backfill), `0003_drop_share_token` (contract), all from `okm generate`.

## Run it locally

From the repository root:

```sh
bun install
bun run build
bun run db:up
bun test packages/reference-app
```

Without the Postgres topology the database tests are skipped. `REQUIRE_DOCKER=1` makes them fail instead. To run a command against your own database:

```sh
cd packages/reference-app
PREVIEW_DATABASE_URL=postgres://... bun ../../dist/okm.js migrate apply --target preview
```

The plan creates `ref_app` without a password. The infrastructure sets one and grants `SELECT ON okm_meta` (a known limit).

## What each CI job proves

The Postgres rows run on a pull request that has the label `needs: postgres`, and on the release and weekly matrix. `CI / gate / check` runs on every pull request.

| Job                                              | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Postgres / suite / 15`, `Postgres / suite / 18` | Every use case on real Postgres through `okmodel/testing`, with the board in one statement, the report in two, and `isolation()` on every tenant table. Two preview jobs at once, each with its own database provisioned from the head snapshot, checked, and sharing no rows. A rehearsal on a `TEMPLATE` clone of a populated database at `0001_init`: `migrate check`, then the expand with its backfill and the contract; the original is unchanged, and as a protected target `migrate check` refuses it. The topology as `ref_app`: reads on a replica, read-your-write with replay paused, the report on a replica. A typecheck against the built declarations. |
| `Postgres / tarball / 18`                        | The same suite with `okmodel` extracted from the packed tarball into `node_modules/okmodel`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CI / gate / check`                              | The typecheck. The database tests are skipped there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
