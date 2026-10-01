/**
 * Rewrites the spike type-cost locks from a fresh compiler run.
 *
 * `bun run spikes:update` calls this. The lock tests stay strict: they compare
 * a new run with the files this script writes. Timings are not part of the lock.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { measureSafety } from "./safety/measure.js";
import { measureTypes } from "./types/measure.js";

const types = measureTypes();
writeFileSync(
  new URL("../types/results.json", import.meta.url),
  `${JSON.stringify(types, null, 2)}\n`,
);

const safety = measureSafety();
const locked = {
  compiler: safety.compiler,
  seed: safety.seed,
  rows: safety.rows.map((row) => ({
    label: row.label,
    strategy: row.strategy,
    tables: row.tables,
    instantiations: row.instantiations,
    types: row.types,
    exitCode: row.exitCode,
  })),
};
const safetyTarget = new URL("../safety/results.json", import.meta.url);
mkdirSync(new URL(".", safetyTarget), { recursive: true });
writeFileSync(safetyTarget, `${JSON.stringify(locked, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ types: types.compiler, safety: locked.rows.length }, null, 2)}\n`,
);
