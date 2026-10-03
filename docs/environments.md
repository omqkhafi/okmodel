# Environments

An environment is a named target. Nothing about it is inferred from `NODE_ENV` or from the name (spec §19.8). Protection is `protected: true` on that entry. A pipeline always passes `--target`.

In 0.1, `okm migrate apply` replays the migration files on the named target. Installing the head snapshot on an empty database, and the check that a snapshot and a replayed history reach the same catalog (OKM1521), arrive with provisioning in P53A. The recipes below are the spec's recipes. The 0.1 commands replay history.

## Preview

One ephemeral database per pull request. Infrastructure creates it (a branch, `CREATE DATABASE`, or a container). OKModel does not drop it.

1. Create the empty database.
2. Register it as a target, for example `preview`.
3. `okm migrate apply --target preview`. In 0.1 this replays every migration file. From P53A, an empty target installs the head snapshot and `reference` rows instead of replaying history (spec §19.6).
4. Optionally seed, then deploy the application with the preview URL.
5. Deleting the database when the pull request closes is the infrastructure's job.

## Rehearsal

To try pending migrations against realistic data, clone or branch the production database, register the clone as a target, and run:

```sh
okm migrate apply --target rehearsal
```

In 0.1 that replays the pending migration files on the clone. The report is the command's stdout: which migrations ran, and the error if a step stops. Per-step duration, locks, and retries as a separate rehearsal command are not a 0.1 feature. The recipe is still `apply` on a clone, not a new command.

A preview built from the head snapshot and a rehearsal built by replaying history are required to match. That equivalence check is P53A. 0.1 does not run it.
