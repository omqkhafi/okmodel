# OKE Windows audit

Report only. It follows [#219](https://github.com/omqkhafi/okmodel/issues/219). The OKE `store.sql` prototype starts after 0.6 and uses the public API (D217, D240). That prototype is not in this repository. This file is the Windows-sensitive part of the public API and of `okm` that the prototype calls.

Base: `31a9f33` (`0.8.0-next.11`). This run is macOS. No Windows process ran. `.github` has no `windows-latest` job. `path.win32` below is Node's Windows path algorithm, executed here. It is not a Windows process.

Each row uses one label:

- **works** — a test in this repo feeds the Windows-sensitive input and passes. The test does not have to run on Windows when the input is those bytes or that string.
- **probably works** — the implementation is the platform API, or `path.win32` accepted the input here, and no test has run on Windows.
- **fails** — the result is wrong for a case-insensitive volume. The call that shows it is named.
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
| A drive letter, a UNC path, a parent segment, and a directory with a space | **probably works** | `path.win32.resolve` on this machine: `C:\app` + `C:\app\schema.ts` stays `C:\app\schema.ts`; `C:\app\nested` + `..\schema.ts` is `C:\app\schema.ts`; `C:\app` + `\\server\share\schema.ts` stays the UNC path; `C:\Program Files\app\nested` + `..\schema.ts` is `C:\Program Files\app\schema.ts`. No test calls `path.win32`. |
| `artifactDir` drops a trailing `/` or `\` | **works** | [`artifactDir`](../src/runtime/drift.ts). [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`artifactDir drops a trailing slash or backslash`), including `C:\proj\.okm\`. |
| The default artifact directory is `` `${cwd}/.okm` ``, forward slash included when `cwd` uses backslashes | **unknown** | [`artifactDir`](../src/runtime/drift.ts) and `readText` in the same file. Bun uses `Bun.file`. Node uses `process.getBuiltinModule("node:fs/promises").readFile`. Proof: on Windows, under Bun and under Node, with `.okm/catalog.hash` present and different from `okm_meta`, `connect()` reports that directory. A mixed path that the runtime rejects makes `connect` hash the schema in memory and ignore the file. |
| A stack frame with `\` records `file.ts:line` | **works** | [`locationFromLines`](../src/contracts/location.ts). [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`callerLocation reads a backslash frame`). |
| The `Error.stack` text Node or Bun actually emits on Windows | **unknown** | The fixture above is a string, not a live stack. `source` is stored on catalog provenance and hashed ([`serializeCatalog`](../src/contracts/catalog/document.ts)). Proof: define `table()` on Windows under Bun and under Node, print the recorded `source`, and compare `catalogHash` with a Linux build of the same file. |
| Importing `okmodel.config.ts`, the schema module, and `okm seed`'s file | **unknown** | The `file://` URL plus `?okm=` query is [`loadConfig`](../src/tooling/migrate/project.ts) and [`seedProject`](../src/tooling/migrate/seed.ts). Proof: `okm generate init` and `okm seed <file>` on Windows, Node 22.18+ and `bun --bun`, including a project path that contains a space. |
| A Windows named-pipe host | **unknown** | [`docs/known-limits.md`](known-limits.md) says to use a TCP URL. No test passes a pipe. Cancel on node-postgres treats a host that starts with `/` as a filesystem socket ([`cancelBackend`](../src/adapters/pg/nodepostgres.ts)). Proof: `connect` with a named-pipe host and record the error. |

## Case-insensitive file names

| Item | Label | Evidence |
| --- | --- | --- |
| `okm check` and a table file whose stem differs in case from the schema text | **fails** | [`unlistedTableFiles`](../src/tooling/migrate/project.ts) uses `schemaSource.includes(stem)`. A direct call with `import { tasks } from "./tasks"` and `["Tasks.ts"]` returned `["Tasks.ts"]`, which `checkProject` reports as OKM1024. The committed test uses a matching stem ([`tests/migrate.test.ts`](../tests/migrate.test.ts), `unlisted table files are the ones the schema source does not mention`). On a case-insensitive volume that import still loads the file. Proof on a runner: `tables/Tasks.ts` on disk, schema text that only contains `tasks`, `okm check`. |
| Two module paths that differ only by case (`Schema.ts` and `schema.ts`) | **unknown** | [`docs/known-limits.md`](known-limits.md) says the catalog treats those strings as different modules. Provenance `source` is `file.ts:line` from the stack, and it is inside the hash. Proof: the hash comparison in the stack row above, plus a second import of the same file under the other spelling. |
| Migration discovery requires the suffix `.sql` and the sibling `.catalog.json` | **probably works** | [`loadMigrations`](../src/tooling/migrate/files.ts) uses `endsWith(".sql")`. `okm generate` writes those lowercase suffixes. A file renamed to `.SQL` would be skipped. Proof: `readdir` of `migrations/` after `okm generate` on Windows. |

## Shell scripts

| Item | Label | Evidence |
| --- | --- | --- |
| The published package | **works** | [`package.json`](../package.json) `files` is `dist`, `README.md`, and `LICENSE`. The bins are a Node shebang plus an import ([`scripts/write-bin-wrappers.ts`](../scripts/write-bin-wrappers.ts)). `okm` does not spawn a shell (`shell` is unset on the one `spawn`). |
| Docker entrypoints | **works** | [`packages/harness/docker/primary-init.sh`](../packages/harness/docker/primary-init.sh) and [`packages/harness/docker/replica-entrypoint.sh`](../packages/harness/docker/replica-entrypoint.sh) are bash for the test topology. The public API does not run them. |

## `bun` and `bunx`

The guides tell a project to run `bunx okm`, and `bun --bun okm` when the command must use Bun ([`docs/guide.md`](guide.md), [`docs/quickstart.md`](quickstart.md)). `engines.node` is `>=22.18`.

| Item | Label | Evidence |
| --- | --- | --- |
| `bunx okm` and `bun --bun okm` start on Windows | **unknown** | The bin shebang is `#!/usr/bin/env node` ([`scripts/write-bin-wrappers.ts`](../scripts/write-bin-wrappers.ts)). Windows runs a package-manager shim, not that shebang. Proof: both commands print the version from a packed tarball on Windows, then `okm generate init` completes. |
| Node older than 22.18 is told to run `bun --bun okm` and then exits | **works** | [`nodeStartupMessage`](../src/tooling/node-version.ts). [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`Node older than 22.18 is told to use bun --bun okm`). The message is a string. It does not launch Bun. |
| `okm driver test` from the packed package spawns `process.execPath` | **probably works** | [`driver-test.ts`](../src/tooling/driver-test.ts): a runner path that ends in `.ts` uses the command `bun`; otherwise it uses `process.execPath`. The packed runner is `.js`. `spawn` does not set `shell`. Proof: `okm driver test pglite` from the packed tarball on Windows. |
| `okm driver test` from a source checkout spawns `bun` | **unknown** | Same file, command `bun`, no shell. Proof: that command on Windows from a checkout where `runnerPath()` still sees `driver-run.ts`. |

## File watchers

| Item | Label | Evidence |
| --- | --- | --- |
| A filesystem watcher | **works** | Nothing under `src/` calls `fs.watch` or `watchFile`. [`src/adapters/pg/watch.ts`](../src/adapters/pg/watch.ts) listens for `abort` on an `AbortSignal`. |

## Temp directories

| Item | Label | Evidence |
| --- | --- | --- |
| `okm` scratch space | **works** | No `os.tmpdir` or `mkdtemp` under `src/`. `okm migrate check` replays into a Postgres schema named `okm_check_` plus a random suffix ([`src/tooling/migrate/check.ts`](../src/tooling/migrate/check.ts)). |
| `okm dev` data directory | **unknown** | [`devProject`](../src/tooling/migrate/dev.ts) creates `.okm/dev-db` with `mkdirSync` and opens PGlite on that path. Proof: `okm dev` on Windows, then a second process opening the same directory. |

## Process signals

| Item | Label | Evidence |
| --- | --- | --- |
| A handler for `SIGINT`, `SIGTERM`, `SIGHUP`, or `SIGBREAK` | **works** | Nothing under `src/` calls `process.on`. |
| An idle postgres.js or node-postgres socket is unref'd so a finished script can exit | **unknown** | Unref is [`PoolSockets`](../src/adapters/pg/postgresjs.ts) and [`cancelBackend`](../src/adapters/pg/nodepostgres.ts). [`tests/client-close.test.ts`](../tests/client-close.test.ts) (`a finished postgres script exits on bun and node`) passes on the OS that runs CI. Proof: the same script on Windows, Bun and Node, exits without `close()`, and a Ctrl+C during a query does not leave an uncaught socket error. |

## Writes under `.okm/`

| Item | Label | Evidence |
| --- | --- | --- |
| `okm generate init` writes `.gitattributes` once | **works** | [`writeGitAttributes`](../src/tooling/migrate/project.ts). The text is `migrations/*.sql text eol=lf`, `*.catalog.json text eol=lf`, and `.okm/** text eol=lf`. [`tests/crlf-safety.test.ts`](../tests/crlf-safety.test.ts) (`okm generate init writes .gitattributes once`, `an existing .gitattributes is not edited by generate init`). |
| `catalog.json`, `catalog.hash`, `types.d.ts`, and the migration SQL stay LF on a Windows disk, and Git checks them out as LF | **unknown** | The strings use `\n`. `writeFileSync` is called with those strings ([`writeArtifact`](../src/tooling/migrate/project.ts), [`generateProject`](../src/tooling/migrate/project.ts)). An existing `.gitattributes` is left unchanged, so a project that already has one does not gain `eol=lf`. Proof: after `okm generate init` on Windows, those files contain `\n` and no `\r`; with `core.autocrlf=true`, a clone that has the generated attributes still has LF; a clone whose `.gitattributes` omits the three lines may be CRLF, and `okm migrate check` still matches the LF plan (the reader row above). |

This repository itself has no `.gitattributes`. That file is [#218](https://github.com/omqkhafi/okmodel/issues/218), not this audit.

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
| works | 17 |
| probably works | 4 |
| fails | 1 |
| unknown | 10 |

The failure is the table-file stem compare. The ten unknowns are the ones a Windows process has to run: the default `.okm` read, a live stack and its hash, dynamic import of `.ts`, a named pipe, two casings of one module, `bunx` / `bun --bun`, `spawn("bun")` from a source checkout, PGlite's dev directory, socket unref, and LF bytes after a Windows write and a Git checkout.
