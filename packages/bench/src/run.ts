/**
 * Writes a timing for the 200-table fixture.
 *
 * The JSON lands in `results/latest.json`. Copy a result into `baselines/`
 * when you want a reference. Nothing compares them yet.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fixtureHash, generateFixture, renderFixtureDdl } from "../../harness/src/fixtures.js";

const root = join(import.meta.dir, "..");
const started = performance.now();
const fixture = generateFixture({ seed: 1, tables: 200 });
const ddl = renderFixtureDdl(fixture);
const ms = performance.now() - started;

const output = {
  name: "fixture-200",
  seed: fixture.seed,
  tables: fixture.tables.length,
  ddlBytes: new TextEncoder().encode(ddl).byteLength,
  hash: fixtureHash(fixture, ddl),
  ms: Math.round(ms * 1000) / 1000,
};

const results = join(root, "results");
mkdirSync(results, { recursive: true });
writeFileSync(join(results, "latest.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output));
