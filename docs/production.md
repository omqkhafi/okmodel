# Production

Nothing about an environment is inferred from `NODE_ENV` or from a target's name (spec §19.8).

- Set `protected: true` on the production target. A target named `production` is not protected by that name. `okm push` is refused only when the target is protected.
- Call `connect({ requireMeta: true })` for a production database. A missing `okm_meta` is then OKM1520. The default is off so an existing database can adopt OKModel. A database whose catalog is behind the app is also OKM1520, with or without that option, until `okm migrate apply`. The 0.6 name change is `RENAME CONSTRAINT` and does not drop the table. A protected target needs `--allow-protected` on that invocation.
- Pass `--target` whenever more than one target is configured and the command must pick one database (`okm migrate apply`, `okm push`, `okm seed`, `okm migrate check`, and a one-database `okm check`). Omitting it then is OKM1853. `okm migrate status` lists every target and does not require `--target`; it stops at the first unreachable one. `okm check` with several targets and no `--target` only lints and prints `ok` (it does not connect).
- Do not point `okm migrate apply`, `okm seed`, or a connecting `okm check` at a pooler. A host containing `pooler`, `pgbouncer`, or `-pooler`, port `6543` or `6432`, or `?pgbouncer=true` is refused unless `--allow-pooler` is set. Migrate strips the `pgbouncer` query parameter before the URL becomes a startup parameter; other pooler hints in the URL are not interpreted. After connecting, those commands probe `pg_backend_pid()` across eight reads on the apply session. Two or more distinct pids are OKM1854. That probe catches a transaction-mode pooler that rotates backends between statements (`server_round_robin=1`). Default LIFO PgBouncer (`server_round_robin=0`) on a non-heuristic port can keep one pid for all eight reads, so mark it with `?pgbouncer=true` (or put `pooler` / `pgbouncer` in the host) instead of relying on the probe. Warm-and-hold with a second connection is not used during apply/seed: it deadlocks single-session targets. `--allow-pooler` skips the URL check and the probe. Apply wants a direct connection.
- Leave `prepared` unset, or set `prepared: "unnamed"`, behind a transaction-mode pooler. `prepared: "named"` is for a direct connection. Named statements are not for a transaction-mode pooler.

```ts
import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./schema.ts",
  targets: {
    production: { url: process.env.DATABASE_URL, protected: true },
  },
});
```

```ts
import { connect } from "okmodel/pg/postgresjs";
import { schema, table, t } from "okmodel/pg";

const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });
const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");

const db = await connect(url, {
  schema: app,
  requireMeta: true,
});
await db.close();
```

Apply that target by name:

```sh
okm migrate apply --target production
```
