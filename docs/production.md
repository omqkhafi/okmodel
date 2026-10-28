---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: [OKM1520, OKM1707, OKM1853, OKM1854, OKM2201, OKM2202, OKM2203, OKM2204]
---
# Production

Nothing about an environment is inferred from `NODE_ENV` or from a target's name (spec §19.8).

- Set `protected: true` on the production target. A target named `production` is not protected by that name. `okm push` is refused only when the target is protected.
- Call `connect({ requireMeta: true })` for a production database. A missing `okm_meta` is then OKM1520. The default is off so an existing database can adopt OKModel. A database whose catalog is behind the app is also OKM1520, with or without that option, until `okm migrate apply`. The 0.6 name change is `RENAME CONSTRAINT` and does not drop the table. A protected target needs `--allow-protected` on that invocation.
- Pass `--target` whenever more than one target is configured and the command must pick one database (`okm migrate apply`, `okm push`, `okm seed`, `okm migrate check`, and a one-database `okm check`). Omitting it then is OKM1853. `okm migrate status` lists every target and does not require `--target`; it stops at the first unreachable one. `okm check` with several targets and no `--target` does not connect. It prints `server checks skipped: N targets, pass --target <name>`, then the lint text and `ok`.
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

## Check a production target

`okm doctor --production` reads one target and reports how it differs from the setup above. It is read-only: every query runs in one `READ ONLY` transaction on one fresh session, and the command makes no network call beyond the target database. It needs a target. With several targets and no `--target` it is OKM1853 and exit 2, not a skip. It takes no error code, and `--bundle` is a different command. `--allow-pooler` on this command changes no connection. It tells the check that apply is allowed through a pooler, which turns a pooler URL from a warning into a fail.

```sh
okm doctor --production --target production
```

A finding has a stable id, a severity (`fail`, `warn`, or `ok`), and a one-line fix. The command exits 1 when any finding is `fail` (OKM2204) and 0 otherwise. `--json` prints the `okm.cli/1` envelope with `data.production`; the warn and fail findings are also in `warnings`. The output names the target as ``target `production` ``. It never prints the URL, host, user, or password. A failed connection says ``Could not read target `<name>` `` and exits 5. When the driver message contains `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, `EHOSTUNREACH`, `28P01`, `28000`, `3D000`, or `57P03`, that token is appended in parentheses.

```text
target `production`
ok    target-protection           The target sets protected: true.
warn  pooler             OKM2203  The target URL looks like a pooler (the host name). okm migrate apply refuses it.
                                  fix: Point the target at a direct connection.
ok    okm-meta                    okm_meta exists. The check cannot see connect() options: confirm the app passes requireMeta: true.
ok    role-privilege              The login role is not a superuser and does not have BYPASSRLS.
warn  role-owns-tables   OKM1707  The login role owns 3 of the schema's tables. That is fine for the migrator and wrong for the app role: an owner is not bound by row-level security.
                                  fix: Run the app as a role that does not own the tables (docs/roles.md).
ok    lock-timeout                okm migrate apply sets lock_timeout to 5000 ms (default) and that value applies to migrations. The role's session value is 0 (no limit) and applies to everything else.
warn  statement-timeout  OKM2201  statement_timeout is 0 for this role in a fresh session, so a statement runs without limit. okm migrate apply sets 30000 ms (default) for migrations only.
                                  fix: Run ALTER ROLE <app role> SET statement_timeout = '30s' (or the limit you want).
ok    server-version              The server is PostgreSQL 17, inside the supported window 15-18.
ok    extensions                  The schema requires no extension.
0 fail, 3 warn, 6 ok
```

| Id | Fails when | Warns when | Code |
| --- | --- | --- | --- |
| `target-protection` | The target does not set `protected: true` in the config. A target name, `NODE_ENV`, and a fingerprint in this machine's store do not count. | Never. | OKM2202 |
| `pooler` | The URL has a pooler host, port 6543 or 6432, or `?pgbouncer=true`, and `--allow-pooler` or `allowPooler` is on. | The same URL patterns, with neither opt-in. | OKM2203 |
| `okm-meta` | `okm_meta` does not exist in the catalog schema. | Never. | OKM1520 |
| `role-privilege` | The role the URL logs in as is a superuser or has `BYPASSRLS`. | Never. | OKM1707 |
| `role-owns-tables` | Never. | The login role owns, or inherits ownership of, a table in the catalog. Fine for the migrator, wrong for the app role. | OKM1707 |
| `role-config` | `config.roles` is set and its role check fails (a named role is missing, `CREATEROLE` is missing, or a grant is not reachable). The check is the one `okm doctor` already runs. | Never. | the role check's own code |
| `lock-timeout` | Never. | `okm migrate apply` sets `lock_timeout` to 0 (`timeouts.lock: 0`). Apply always sets its own value, 5000 ms by default, so that is the value reported; the role's session value is named beside it. | OKM2201 |
| `statement-timeout` | Never. | `statement_timeout` is 0 for the role in a fresh session. Apply sets its own value for migrations only and does not change what the app role gets. | OKM2201 |
| `server-version` | The server is below 15, or below the schema's `minPostgres`. | The server is newer than 18. | OKM1802, OKM1803 |
| `extensions` | A required extension is not installed, and no pending migration creates it. An applied migration does not count after a later drop. A database with no history and no migration files does not fail for a declared extension while the package is available: the initial migration will create it. An operator class whose extension is not declared still fails. | Never. | OKM1811 |

The doctor cannot see `connect()` options. `requireMeta: true` is an application option, so a present `okm_meta` is reported as `ok` with a reminder, and a missing one is a fail because `requireMeta` would refuse that database (OKM1520). It also cannot tell whether a login is the migrator or the app role: the role finding says what the login role can do, and you read it against the role you meant. A `--lock-timeout` or `--statement-timeout` on one `okm migrate apply` run overrides the apply value the doctor reports. The check does not report whether an exposed table has validation off: the catalog does not record `validation`, so there is no finding for it ([known limits](known-limits.md)). The role recipe is [roles](roles.md).
