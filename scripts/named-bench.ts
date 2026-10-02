/**
 * Compares named prepared statements with the unnamed protocol on postgres.js.
 *
 * A direct connection, repeated identical statements. Prints p50 milliseconds.
 */

import { open } from "../src/adapters/pg/postgresjs.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const runs = 40;
const warmup = 10;

async function sample(prepared: "named" | "unnamed"): Promise<number> {
  const pool = open({ url: primaryUrl(), prepared, max: 1 });
  try {
    await pool.execute("select 1");
    for (let index = 0; index < warmup; index += 1) {
      await pool.execute("select $1::int", [String(index)]);
    }
    const times: number[] = [];
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      await pool.execute("select $1::int", ["7"]);
      times.push(performance.now() - started);
    }
    times.sort((left, right) => left - right);
    return times[Math.floor(times.length / 2)] ?? 0;
  } finally {
    await pool.close();
  }
}

const unnamed = await sample("unnamed");
const named = await sample("named");
const faster = (unnamed - named) / unnamed;
console.log(
  JSON.stringify({
    unnamedP50Ms: unnamed,
    namedP50Ms: named,
    faster,
    keep: faster >= 0.15,
  }),
);
