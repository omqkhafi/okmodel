# Example application

`packages/reference-app` is a small project tracker that uses OKModel only through its public entry points. It is private and not published. CI runs it as the end-to-end proof (D207).

## What it is

- Workspaces are the tenants (column tenancy on `workspaceId`). `workspaces` is global.
- Tables: `members`, `projects`, `tasks`, `comments`. Every table has `timestamps()`. `projects` and `tasks` are `archivable()`, and archiving a project archives its tasks.
- A `task_status` enum, the `task_is_open` SQL function, and two views: `active_projects` and `open_tasks` (which calls the function).
- The managed application role `ref_app` with the default grants. The migration role is `okm`.
- Three migrations from `okm generate`: `0001_init`, `0002_public_id` (expand: a new column filled by a batched backfill), and `0003_drop_share_token` (contract).

The use cases are plain functions in `src/use-cases.ts`: create a workspace, add a project and tasks, comment, move a task, archive and restore a project, page through a board with includes, and a report read from a replica (`route: "replica"`).

## Workflows it proves

**Preview.** Each job creates an empty database, runs `okm migrate apply --target preview` (the head snapshot), then `okm check`. Two jobs run at once and share no rows. They can both create the managed role for the first time. See [environments](environments.md).

**Rehearsal.** The database standing in for production is cloned with `CREATE DATABASE clone TEMPLATE original`. `okm migrate check` and `okm migrate apply` run on the clone: the expand, its backfill, then the contract. The original does not change. As a protected target, the original is refused by `okm migrate check` before any write. `okm migrate apply` on a protected target runs the expand steps and stops at the backfill with OKM1850. See [known limits](known-limits.md).

**Topology.** On one primary and two hot standbys, board reads go to a replica. A board read right after a move sees the move from the primary while both replicas are paused (`fallback:behind`). The report stays on a replica. See [topology](topology.md).

## Run it

```sh
bun run build
bun run db:up
bun test packages/reference-app
```

The infrastructure sets the application role's password and grants it `SELECT` on `okm_meta`; OKModel stores neither (see [known limits](known-limits.md)). `packages/reference-app/README.md` lists what each CI job proves.
