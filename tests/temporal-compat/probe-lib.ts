/**
 * QA-L2: the shipped Temporal names merge with TypeScript's Temporal lib.
 *
 * This project does not include `temporal.local.d.ts`.
 */

import type { TimeWithOffset } from "../../src/dialects/pg/temporal.ts";

const instant = Temporal.Instant.from("2020-01-01T00:00:00.123456Z");
const shown = instant.toString({ fractionalSecondDigits: 6 });
const sample: TimeWithOffset = {
  time: Temporal.PlainTime.from("00:00:00"),
  offset: "+00:00",
};

void shown;
void sample;
