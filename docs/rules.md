# Rules in force

What an agent must follow. Each rule cites the decision that records it. A cited decision has a file under `docs/decisions/` and is not superseded or historical. The index is `docs/decisions/INDEX.md`.

1. The spec (`docs/okmodel-api-design.md`) is normative (D42). Decision records are one file each under `docs/decisions/`. Do not edit an accepted record. A change is a new file. `bun run decisions:index` rewrites the index. `bun run decision:next` prints the next free number.
2. TypeScript 7 (`tsc`) typechecks the repository and emits declarations. Nothing in `src/` or the repository checks imports the TypeScript compiler API (D111).
3. Type correctness is `expectTypeOf` in `*.test-d.ts` files compiled by that typecheck (D114).
4. Imports go down the five layers: contracts, dialects, adapters, runtime, tooling. Adapters import contracts or other adapter files, not dialects (D81). `bun run layers-check` enforces it.
5. No `node:*` in the core, and no runtime dependencies (D74). The postgres.js adapter may import `node:net` to unref an idle pool socket. The node-postgres adapter may import it to cancel a query. `src/dialects/pg/catalog-require.js` may import `node:module` so the catalog compiler loads on the first `.catalog` read.
6. One `OkmError`. Codes are `OKM1xxx` (D20, D110).
7. The published package is ESM only. There is no CommonJS build (D112).
8. Build for performance, speed, lightness, and cold start. Nothing enters the runtime entry without need. No module-level computation. Lazy work. One helper, one place. No second shape that means the same thing. A step ends by removing the dead path it replaced (D129).
9. Size and type cost are reports. The scripts exit 0. There is no byte ceiling and no type-cost ceiling. `layers-check`, `core-purity`, and `bundle-purity` stay structural guards (D354).
10. No down migrations. Recovery is a new forward migration (D104).
11. Behavioural tests run on a real database. No database mocks. File checks are for artifacts (D88).
12. One protection policy for the CLI, engine, backfill, seed, runner, and provision. `--allow-protected` is per invocation. Protection does not affect runtime `connect()` (D100).
13. Every commit ends with the DCO sign-off `Signed-off-by: Omq Khafi <omqkhafi@gmail.com>` and `Co-authored-by: Ali Alnaghmoush <alialnaghmoush@gmail.com>`, and nothing else (D109). Do not edit `changelog.md` or bump the version on a pull request.
14. One `type:` label and at least one `area:` label. A pull request title is `type(scope): summary`. A pull request has no `Closes #N` line and no milestone. Agents do not open issues (D206).
15. After merge is a manual workflow. No workflow opens an issue. Agents never merge and never tag (D331). Edit a workflow file only when the prompt allows it, or when a workflow bug blocks CI: the smallest fix, its own commit, named in the report.
16. Support is PostgreSQL 15 and later. Tested majors are 15, 16, 17, 18, and 19. A newer major is untested until a decision adds it (D353).
17. A gate ends with a hygiene step: dead code, duplicated helpers, flaky tests, and doc sync, before the release bump (D115).
18. Use Bun only (`bun`, `bunx`). The version is `.bun-version`. Do not use npm, pnpm, yarn, or another package manager.
