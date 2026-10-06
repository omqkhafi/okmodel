# Environments

An environment is a named target. Nothing about it is inferred from `NODE_ENV` or from the name (spec §19.8). Protection is `protected: true` on that entry. A pipeline always passes `--target`.

An empty target installs the head snapshot and `reference` rows. A target that already has history replays pending files. See [provisioning](provisioning.md).

## Preview

One ephemeral database per pull request. Infrastructure creates it (a branch, `CREATE DATABASE`, or a container). OKModel does not drop it.

1. Create the empty database.
2. Register it as a target, for example `preview`.
3. `okm migrate apply --target preview`. An empty database installs the head snapshot and `reference` rows (spec §19.6).
4. Optionally seed, then deploy the application with the preview URL.
5. Deleting the database when the pull request closes is the infrastructure's job.

Register the preview target in `okmodel.config.ts`:

```ts
import { defineConfig } from "okmodel/migrate";

const url = process.env.PREVIEW_DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error("PREVIEW_DATABASE_URL is not set");
}

export default defineConfig({
  schema: "./schema.ts",
  targets: {
    preview: url,
  },
});
```

## Rehearsal

To try pending migrations against realistic data, clone or branch the production database, register the clone as a target, and run:

```sh
okm migrate apply --target rehearsal
```

A clone already has history, so this replays the pending migration files. The report is the command's stdout: which migrations ran, and the error if a step stops. Per-step duration, locks, and retries as a separate rehearsal command are not in this version. The recipe is still `apply` on a clone, not a new command.

A preview built from the head snapshot and a rehearsal built by replaying history are required to match. `okm migrate check --provision` is that comparison. See [provisioning](provisioning.md).
