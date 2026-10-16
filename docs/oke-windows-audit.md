# OKE Windows audit

Report only. It follows [#219](https://github.com/omqkhafi/okmodel/issues/219). The OKE `store.sql` prototype starts after 0.6 and uses the public API (D217, D240). That prototype is not in this repository. This file is the Windows-sensitive part of the public API and of `okm` that the prototype calls.

Base: `31a9f33` (`0.8.0-next.11`). That pass was macOS. `path.win32` below is Node's Windows path algorithm from that pass, unless a row names the later Windows job.

The Windows job is [Actions run 38902566422](https://github.com/omqkhafi/okmodel/actions/runs/38902566422) on [#298](https://github.com/omqkhafi/okmodel/pull/298). `windows-latest`, Bun 1.4.2, Node v22.23.3, packed `0.8.0-next.14`. It is not a required check. A step that needs a TCP Postgres URL was skipped.

Each row uses one label:

- **works** — a test in this repo feeds the Windows-sensitive input and passes. The test does not have to run on Windows when the input is those bytes or that string.
- **probably works** — the implementation is the platform API, or `path.win32` accepted the input here, and no test has run on Windows.
- **fails** — the result is wrong. The call that shows it is named.
- **unknown** — a Windows process has to show it. The proof is in the row.

`src/` has no `process.platform`, no `fs.watch`, no `os.tmpdir`, and no `mkdtemp`. The only `spawn` is `okm driver test`.

## Line endings

Readers normalize text in memory. Writers join lines with `\n` ([`src/tooling/migrate/plan.ts`](../src/tooling/migrate/plan.ts) `formatPlan`, [`src/tooling/migrate/project.ts`](../src/tooling/migrate/project.ts) `writeArtifact`).

| Item | Label | Evidence |
| --- | --- | --- |
| Migration SQL: `\r\n`, a lone `\r`, and a leading UTF-8 BOM become the same plan as LF | **works** | [`prepareMigrationText`](../src/tooling/migrate/text.ts). [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`parsePlan treats CRLF, lone CR, and a BOM like LF`, `a formatted plan round-trips when the file is CRLF`, `reference-app migrations keep their steps when the bytes are CRLF`). Real Postgres: [`tests/crlf-safety-pg.test.ts`](../tests/crlf-safety-pg.test.ts) (`generate, check, status, and apply treat a BOM CRLF migration like LF`). |
| A non-empty file with no steps is `no-steps` in CRLF, including `okm migrate status` before a connection | **works** | [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`a non-empty file with no steps fails, and -- no steps does not`, `a zero-step file fails status before any connection`). |
| `.okm/catalog.json` and `catalog.hash`: a BOM is stripped and every `\r` is removed. An LF document keeps its hash | **works** | [`catalogFileText`](../src/contracts/catalog/document.ts). [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`an LF catalog hash is unchanged when CR and a BOM are stripped`). |
| UTF-16 (a NUL byte) is refused. Migrations use reason `utf16`. A catalog uses OKM1027 | **works** | Same test file (`UTF-16 migration text is refused`, and the OKM1027 expectation in the hash test). |
| OKM1550 sees `\n`, `\r\n`, and `\r` | **works** | [`tests/rls-guards.test.ts`](../tests/rls-guards.test.ts) (`OKM1550 sees LF, CRLF, and CR, and an allow needs a reason`). |
| OKM1551 sees a CRLF `commit` | **works** | [`tests/lint.test.ts`](../tests/lint.test.ts) (`OKM1551 flags transaction control and an allow needs a reason`), the `\r\ncommit` input. |
| `okm generate` writes migration SQL with `\n` | **works** | [`tests/crlf-safety-pg.test.ts`](../tests/crlf-safety-pg.test.ts) expects the generated file to contain no `\r`, then rewrites it to CRLF and applies it. That test has not run on Windows. |
| `t.jsonb<T>()` recovered from a CRLF schema file for `.okm/types.d.ts` | **probably works** | [`jsonColumnTypes`](../src/dialects/pg/emit.ts) treats `\r` as whitespace (`\s`) and strips a `//` comment through the next `\n`. A direct call on CRLF and lone-CR source returned the same map as LF (`tasks.meta` → `{ published?: boolean }`). No test in `tests/` does this. |

A carriage return inside a SQL literal does not survive the migration read. That is the same normalizer, on every OS ([`docs/known-limits.md`](known-limits.md)).

## Paths

[`projectPath`](../src/tooling/migrate/paths.ts) is `path.resolve`. On Windows that is `path.win32.resolve`. Config, schema, tables, migrations, `out`, seed, and `okm dev` all use it. [`loadConfig`](../src/tooling/migrate/project.ts), [`loadSchema`](../src/tooling/migrate/project.ts), and [`seedProject`](../src/tooling/migrate/seed.ts) then import `pathToFileURL(path).href` plus `?okm=<timestamp>`.

| Item | Label | Evidence |
| --- | --- | --- |
| An absolute spec and a `..` spec resolve from the project directory | **works** | [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`config paths resolve an absolute spec and a parent spec`). The absolute path in that test is whatever `path.join` produces on the machine that runs it. |
| A drive letter, a UNC path, a parent segment, and a directory with a space | **probably works** | `path.win32.resolve` on the macOS pass: `C:\app` + `C:\app\schema.ts` stays `C:\app\schema.ts`; `C:\app\nested` + `..\schema.ts` is `C:\app\schema.ts`; `C:\app` + `\\server\share\schema.ts` stays the UNC path; `C:\Program Files\app\nested` + `..\schema.ts` is `C:\Program Files\app\schema.ts`. The Windows job's `okm generate init` completed for a drive-letter schema, a `..` schema, and a project path that contains a space, on Node and on `bun --bun`. A UNC path was not run. |
| `artifactDir` drops a trailing `/` or `\` | **works** | [`artifactDir`](../src/runtime/drift.ts). [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`artifactDir drops a trailing slash or backslash`), including `C:\proj\.okm\`. |
| The default artifact directory is `` `${cwd}/.okm` ``, forward slash included when `cwd` uses backslashes | **works** | [`artifactDir`](../src/runtime/drift.ts). The Windows job chdir'd to `D:\a\okmodel\okmodel\okm smoke\projects\relative node`, wrote a sentinel `catalog.hash` that was not the in-memory catalog, and stored that sentinel in `okm_meta`. `connect()` from `okmodel/pg/pglite` reached `connected` under Node and under Bun, and printed `connect-read D:\a\okmodel\okmodel\okm smoke\projects\relative node/.okm`. A miss would have compared the in-memory hash and failed. |
| A stack frame with `\` records `file.ts:line` | **works** | [`locationFromLines`](../src/contracts/location.ts). [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`callerLocation reads a backslash frame`). |
| The `Error.stack` text Node or Bun actually emits on Windows | **works** | The Windows job imported the packed schema under Node and under Bun. Both recorded `source=gcefca6p.js:78`. The Linux job recorded the same string. `catalog.hash` was `669f49e777f98173d7ffc717a310ad0a315e91f07f0693420ba9bd5c9065efe9` on Windows Node, Windows Bun, Linux Node, and Linux Bun. |
| Importing `okmodel.config.ts`, the schema module, and `okm seed`'s file | **works** | The Windows job's `okm generate init` loaded the config and the schema on Node v22.23.3 and `bun --bun`, in a path that contains a space, including a drive-letter schema and a `..` schema. `okm seed` was skipped: it needs a TCP URL, and this job does not start one. |
| A Windows named-pipe host | **works** | `connect` from `okmodel/pg/pg` with host `\\.\pipe\okmodel-audit` returned `OkmError: The database is unavailable` under Node and under Bun. The process did not hang. |

## Case-insensitive file names

| Item | Label | Evidence |
| --- | --- | --- |
| `okm check` and a table file whose stem differs in case from the schema text | **works** | [`unlistedTableFiles`](../src/tooling/migrate/project.ts) compares the stem without case. [`tests/migrate.test.ts`](../tests/migrate.test.ts) (`a table file stem matches the schema text without case sensitivity`) expects `["Tasks.ts"]` with `import { tasks } from "./tasks"` to be an empty list. On the Windows job, `bun --bun okm check` printed `ok` for `tables/Tasks.ts`. Node did not resolve the extensionless `./tasks` import, and the error was not OKM1024. |
| Two module paths that differ only by case (`Schema.ts` and `schema.ts`) | **unknown** | [`docs/known-limits.md`](known-limits.md) says the catalog treats those strings as different modules. Provenance `source` is `file.ts:line` from the stack, and it is inside the hash. Proof: the hash comparison in the stack row above, plus a second import of the same file under the other spelling. |
| Migration discovery requires the suffix `.sql` and the sibling `.catalog.json` | **works** | [`loadMigrations`](../src/tooling/migrate/files.ts) uses `endsWith(".sql")`. After `okm generate init` on the Windows job, `migrations/` contained `0001_init.sql` and `0001_init.catalog.json`. |

## Shell scripts

| Item | Label | Evidence |
| --- | --- | --- |
| The published package | **works** | [`package.json`](../package.json) `files` is `dist`, `README.md`, and `LICENSE`. The bins are a Node shebang plus an import ([`scripts/write-bin-wrappers.ts`](../scripts/write-bin-wrappers.ts)). `okm` does not spawn a shell (`shell` is unset on the one `spawn`). |
| Docker entrypoints | **works** | [`packages/harness/docker/primary-init.sh`](../packages/harness/docker/primary-init.sh) and [`packages/harness/docker/replica-entrypoint.sh`](../packages/harness/docker/replica-entrypoint.sh) are bash for the test topology. The public API does not run them. |

## `bun` and `bunx`

The guides tell a project to run `bunx okm`, and `bun --bun okm` when the command must use Bun ([`docs/guide.md`](guide.md), [`docs/quickstart.md`](quickstart.md)). `engines.node` is `>=22.18`.

| Item | Label | Evidence |
| --- | --- | --- |
| `bunx okm` and `bun --bun okm` start on Windows | **works** | Both commands printed `0.8.0-next.14` from the packed tarball. `okm generate init` then completed on Node v22.23.3 and on `bun --bun`. |
| Node older than 22.18 is told to run `bun --bun okm` and then exits | **works** | [`nodeStartupMessage`](../src/tooling/node-version.ts). [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`Node older than 22.18 is told to use bun --bun okm`). The message is a string. It does not launch Bun. |
| `okm driver test` from the packed package spawns `process.execPath` | **works** | [`driverRunnerPath`](../src/tooling/driver-test.ts) checks `driver-run.js` beside the module, then `../tooling/driver-run.js`. The packed runner is `dist/tooling/driver-run.js`. `okm driver test bun` loads a chunk of the runner, so the entry does not import the `bun` package. [`tests/driver-runner.test.ts`](../tests/driver-runner.test.ts). The first Windows job looked only beside the shared chunk. The next run found the runner and Node then failed on `Cannot find package 'bun'`. |
| `okm driver test` from a source checkout spawns `bun` | **unknown** | Same file, command `bun`, no shell. Proof: that command on Windows from a checkout where `runnerPath()` still sees `driver-run.ts`. |

## File watchers

| Item | Label | Evidence |
| --- | --- | --- |
| A filesystem watcher | **works** | Nothing under `src/` calls `fs.watch` or `watchFile`. [`src/adapters/pg/watch.ts`](../src/adapters/pg/watch.ts) listens for `abort` on an `AbortSignal`. |

## Temp directories

| Item | Label | Evidence |
| --- | --- | --- |
| `okm` scratch space | **works** | No `os.tmpdir` or `mkdtemp` under `src/`. `okm migrate check` replays into a Postgres schema named `okm_check_` plus a random suffix ([`src/tooling/migrate/check.ts`](../src/tooling/migrate/check.ts)). |
| `okm dev` data directory | **works** | The Windows job ran `okm dev` twice under Node and twice under Bun. Each run printed the same `.okm\dev-db` path for that runtime. The second open completed. |

## Process signals

| Item | Label | Evidence |
| --- | --- | --- |
| A handler for `SIGINT`, `SIGTERM`, `SIGHUP`, or `SIGBREAK` | **works** | Nothing under `src/` calls `process.on`. |
| An idle postgres.js or node-postgres socket is unref'd so a finished script can exit | **unknown** | Unref is [`PoolSockets`](../src/adapters/pg/postgresjs.ts) and [`cancelBackend`](../src/adapters/pg/nodepostgres.ts). [`tests/client-close.test.ts`](../tests/client-close.test.ts) (`a finished postgres script exits on bun and node`) passes on the OS that runs CI. The Windows job skipped this step: it needs a TCP Postgres URL, and the job does not start a service container. |

## Writes under `.okm/`

| Item | Label | Evidence |
| --- | --- | --- |
| `okm generate init` writes `.gitattributes` once | **works** | [`writeGitAttributes`](../src/tooling/migrate/project.ts). The text is `migrations/*.sql text eol=lf`, `*.catalog.json text eol=lf`, and `.okm/** text eol=lf`. [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`okm generate init writes .gitattributes once`, `an existing .gitattributes is not edited by generate init`). |
| `catalog.json`, `catalog.hash`, `types.d.ts`, and the migration SQL stay LF on a Windows disk, and Git checks them out as LF | **works** | After `okm generate init` on the Windows job, `.gitattributes`, `.okm/catalog.json`, `.okm/catalog.hash`, `.okm/types.d.ts`, and `migrations/*` contained no CR. A clone with `core.autocrlf=true` kept the SQL, the catalog files, and `types.d.ts` as LF. Migrate check and apply against a pre-existing `.gitattributes` were skipped: they need a TCP URL. |

The repository `.gitattributes` is the three `eol=lf` lines `okm generate init` writes (#218).

## What a Windows runner should run

This is the list for [#218](https://github.com/omqkhafi/okmodel/issues/218). The job needs Bun and Node 22.18 or newer. Postgres, when the job includes apply, is a TCP URL.

1. From the packed tarball: `bunx okm --version` and `bun --bun okm --version`.
2. `okm generate init` in a fresh project whose path contains a space, once with a relative schema and once with a drive-letter absolute schema and a `..` schema. Node 22.18+ and `bun --bun`.
3. Bytes of `.gitattributes`, `.okm/catalog.json`, `.okm/catalog.hash`, `.okm/types.d.ts`, and `migrations/*.sql` are LF.
4. `connect()` under Bun and under Node reads `.okm/catalog.hash` when `cwd` is a backslash path. Compare `catalogHash` with a Linux build of the same schema file.
5. `okm check` with `tables/Tasks.ts` while the schema text only contains `tasks`. The current result is OKM1024.
6. Clone with `core.autocrlf=true`. With the generated `.gitattributes`, the SQL and catalog files stay LF. With a pre-existing `.gitattributes` that omits the three `eol=lf` lines, run `okm migrate check` and `okm migrate apply` against the TCP URL.
7. `okm dev`, then a second open of `.okm/dev-db`.
8. A finished postgres.js script exits on Bun and on Node without `close()`.
9. `okm driver test pglite` from the packed tarball.
10. A named-pipe host: record the error.

`okm seed` is step 2's import plus a TCP target. The Docker bash scripts stay off this job.

## Count

| Label | Count |
| --- | --- |
| works | 27 |
| probably works | 2 |
| fails | 0 |
| unknown | 3 |

No row fails. The three unknowns are two casings of one module, `spawn("bun")` from a source checkout, and socket unref. The last one needs a TCP URL, which this job does not start. `okm seed` and migrate check/apply against a pre-existing `.gitattributes` were skipped for the same reason.
