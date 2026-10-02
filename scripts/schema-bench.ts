/**
 * Times `schema()` on the 200-table fixture against loading the serialised catalog.
 *
 * Prints one sample. No ceiling. Spec 19.3, D127.
 */

import { generateFixture } from "../packages/harness/src/fixtures.js";
import { parseCatalog, serializeCatalog } from "../src/contracts/catalog/document.js";
import { fixtureSchema } from "./fixture-schema.js";

const rounds = 5;
const warmups = 3;

/**
 * Median of timed calls, after a few warmups.
 *
 * @param run - Work to time
 * @returns Median milliseconds
 */
function medianMs(run: () => void): number {
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    run();
  }
  const times: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  times.sort((left, right) => left - right);
  return times[Math.floor(times.length / 2)] ?? 0;
}

const fixture = generateFixture({ seed: 1, tables: 200 });
const built = fixtureSchema(fixture);
const json = serializeCatalog(built.catalog);
const buildMs = medianMs(() => {
  fixtureSchema(fixture);
});
const split = medianSplit(json);

process.stdout.write(
  `${JSON.stringify(
    {
      tables: 200,
      objects: built.catalog.objects.length,
      bytes: json.length,
      schemaBuildMs: Number(buildMs.toFixed(3)),
      catalogLoadMs: Number(split.loadMs.toFixed(3)),
      jsonParseMs: Number(split.parseMs.toFixed(3)),
      validationMs: Number(split.validationMs.toFixed(3)),
    },
    null,
    2,
  )}\n`,
);

/**
 * Splits one catalog load into `JSON.parse` and the validation that follows.
 *
 * Each sample parses once, then runs `parseCatalog` (which parses again and
 * checks the document). The validation time is the second call minus the
 * first. A loader that trusts the hash and skips that check would pay the
 * parse and not the difference.
 *
 * @param text - Serialised catalog
 * @returns Median milliseconds
 */
function medianSplit(text: string): {
  readonly parseMs: number;
  readonly loadMs: number;
  readonly validationMs: number;
} {
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    JSON.parse(text);
    parseCatalog(text);
  }
  const parseTimes: number[] = [];
  const loadTimes: number[] = [];
  const validationTimes: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    JSON.parse(text);
    const parsed = performance.now();
    parseCatalog(text);
    const loaded = performance.now();
    const parseMs = parsed - started;
    const loadMs = loaded - parsed;
    parseTimes.push(parseMs);
    loadTimes.push(loadMs);
    validationTimes.push(loadMs - parseMs);
  }
  return {
    parseMs: median(parseTimes),
    loadMs: median(loadTimes),
    validationMs: median(validationTimes),
  };
}

function median(times: readonly number[]): number {
  const sorted = [...times].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
