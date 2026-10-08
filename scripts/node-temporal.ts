/**
 * Date and time columns under Node.
 *
 * CI bundles this file to plain JavaScript and runs it on Node 22, 24, and
 * 26. Node 22 and 24 get `--polyfill`: the script fails when the runtime
 * already has a `Temporal` global, then installs `temporal-polyfill`. Node
 * 26 runs bare: the script fails when no native `Temporal` global exists.
 * Either way every date/time codec round-trips below.
 *
 *   bun build scripts/node-temporal.ts --target node --external temporal-polyfill --outfile /tmp/okm-temporal.mjs
 *   node /tmp/okm-temporal.mjs [--polyfill]
 */

import { date, interval, time, timestamp, timestamptz, timetz } from "../src/dialects/pg/index.js";
import type { TimeWithOffset } from "../src/dialects/pg/index.js";

const polyfill = process.argv.includes("--polyfill");
const holder = globalThis as unknown as Record<string, unknown>;

if (polyfill) {
  if (holder.Temporal !== undefined) {
    throw new Error("node-temporal: --polyfill was passed but this Node already has a native Temporal global");
  }
  const { Temporal } = await import("temporal-polyfill");
  holder.Temporal = Temporal;
} else if (holder.Temporal === undefined) {
  throw new Error("node-temporal: no native Temporal global; rerun with --polyfill");
}

let count = 0;
function round(name: string, encoded: string, decoded: string): void {
  count += 1;
  if (encoded !== decoded) throw new Error(`node-temporal: ${name} changed: ${encoded} became ${decoded}`);
}

const instant = Temporal.Instant.from("2020-01-02T03:04:05.123456789Z");
round("timestamptz", instant.toString(), timestamptz().decode(timestamptz().encode(instant)).toString());
round(
  "timestamptz(0)",
  Temporal.Instant.from("2020-01-02T03:04:05Z").toString(),
  timestamptz(0).decode(timestamptz(0).encode(Temporal.Instant.from("2020-01-02T03:04:05Z"))).toString(),
);
const plain = Temporal.PlainDateTime.from("2020-01-02T03:04:05.123456");
round("timestamp", plain.toString(), timestamp().decode(timestamp().encode(plain)).toString());
const day = Temporal.PlainDate.from("2020-01-02");
round("date", day.toString(), date().decode(date().encode(day)).toString());
const clock = Temporal.PlainTime.from("03:04:05.654321");
round("time", clock.toString(), time().decode(time().encode(clock)).toString());
const zoned: TimeWithOffset = { time: Temporal.PlainTime.from("03:04:05"), offset: "+02:00" };
const zonedBack = timetz().decode(timetz().encode(zoned));
round("timetz", zoned.time.toString(), zonedBack.time.toString());
if (zonedBack.offset !== zoned.offset) {
  throw new Error(`node-temporal: timetz changed offset ${zoned.offset} to ${zonedBack.offset}`);
}
count += 1;
const span = Temporal.Duration.from("P1DT2H3M4.5S");
round("interval", span.toString(), interval().decode(interval().encode(span)).toString());

console.log(
  `temporal node ${process.versions.node} ${polyfill ? "polyfill" : "native"}: ${String(count)} date/time round trips ok`,
);
