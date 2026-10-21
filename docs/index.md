---
okmVersion: "0.10.0"
since: "0.10"
dialects: [postgres]
codes: []
---
OKModel 0.10.0 - agent index

Pointer index for the docs in this package. Open one page. Do not fetch the website.

## Start

- `docs/guide.md` - What OKModel is, and the shape of a schema, a query, and a migration. - Read this first.
- `docs/quickstart.md` - A config, a schema, and one reviewed migration. - Read this when starting a project.
- `docs/api.md` - Which package exports are stable, experimental, or internal. - Read this before choosing an import.
- `docs/compatibility.md` - Postgres majors and drivers that pass conformance. - Read this when picking a driver.
- `docs/known-limits.md` - Behavior this version does not have. - Read this before assuming a feature exists.
- `docs/capabilities.md` - Postgres feature support taken from the registry. - Read this before claiming a feature is native.
- `docs/using-okmodel-safely.md` - Pin the lockfile and read a provenance attestation. - Read this before adding the dependency.
- `docs/index.md` - This pointer index. - Read this to choose the next page.

## Define

- `docs/linter.md` - Lint findings on a migration plan. - Read this when generate, plan, or check reports a finding.
- `docs/extension-compatibility.md` - Default versions of the bundled extensions. - Read this when declaring an extension.
- `docs/type-change.md` - Expand and contract for a type change that rewrites a table. - Read this when a column type must change.
- `docs/readme-examples.md` - Short samples of the public API. - Read this to match a README snippet.

## Query

- `docs/testing.md` - Factories and a cross-tenant isolation check on a real database. - Read this when writing a test.
- `docs/topology.md` - Primary and replica routing. - Read this when a read should use a replica.
- `docs/warnings.md` - Development warnings and the okm check schema rules for keys and indexes. - Read this when a query or a schema should report OKM2xxx advice.

## Migrate

- `docs/adopt-existing.md` - Pull, generate, then baseline an existing database. - Read this when the database already has tables.
- `docs/backfill.md` - Batched row updates inside a migration. - Read this when a new column must be filled.
- `docs/migrate-check.md` - Replay of migration history in a scratch schema. - Read this before apply in CI.
- `docs/migration-failure.md` - What a failed apply leaves in okm_history and okm_steps. - Read this when apply stops mid-step.
- `docs/provisioning.md` - An empty target installs the head snapshot. - Read this when apply meets an empty database.
- `docs/github-action.md` - The composite action that posts a plan comment. - Read this when wiring GitHub CI.
- `docs/environments.md` - Named targets and a preview database. - Read this when more than one database is configured.

## Operate

- `docs/production.md` - Protected targets, requireMeta, and pooler refusal. - Read this before pointing a command at production.
- `docs/protection.md` - How a protected target is recorded and refused. - Read this before using a protection bypass flag.
- `docs/example-app.md` - What the reference app proves end to end. - Read this for a full project shape.
- `docs/observer-events.md` - Event shape for connect onWrite. - Read this when attaching a write observer.
- `docs/untrusted.md` - How text from the database or an error is bounded. - Read this when handling an error or plan JSON.

## Agents

- `docs/roles.md` - Least-privilege roles for an agent login. - Read this before giving an agent a database role.
- `docs/threat-model.md` - What agent use is defended against, and what is not. - Read this before trusting an agent with apply.

## Errors

- `docs/errors/OKM1012.md` through `docs/errors/OKM2300.md` - one page per code - Read `docs/errors/<code>.md` when a command or a client throws that code.

## Commands

- `okm migrate plan` - Print the plan and its lock estimates.
- `okm migrate apply` - Apply pending migrations.
- `okm migrate status` - Print whether the target is current.
- `okm migrate resolve` - Record a committed step, or mark it to run again.
- `okm migrate check` - Replay migration history in a scratch schema.
- `okm migrate baseline` - Record the head snapshot as applied on an existing database.
- `okm catalog export` - Write the catalog snapshot.
- `okm import drizzle` - Import a Drizzle schema.
- `okm driver test` - Run conformance against one driver.
- `okm ext scaffold` - Print a starting extension() definition.
- `okm ext check` - Compare declared extensions with the server.
- `okm ext list` - List extensions the server can install.
- `okm ext test` - Check an extension() definition against the server.
- `okm build` - Write the schema build.
- `okm check` - Lint the schema and compare it with one target.
- `okm dev` - Open a PGlite database in .okm/dev-db, or name a target called dev.
- `okm doctor` - Print a target report, or one error code.
- `okm generate` - Write the next migration.
- `okm push` - Apply the schema diff to one target.
- `okm pull` - Write table files and a schema from one database.
- `okm seed` - Run a seed file on one target.
- `okm protect add` - Record this target's fingerprint in the user protection store.
- `okm protect remove` - Remove this target's fingerprint from the user protection store.
- `okm protect list` - Print fingerprints in the user protection store.
- `okm raw sync` - Describe static raw() calls and write the typed SQL lock.
- `okm schema` - Print the JSON Schema for that command's --json data.
- `okm init` - Write starter files for a package or selected workspace packages.

