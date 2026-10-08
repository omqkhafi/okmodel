/**
 * QA-L2: the shipped Temporal names merge with temporal-polyfill's types.
 *
 * `temporal-spec/global` is the global declaration that package depends on.
 * This project does not include `temporal.local.d.ts` or TypeScript's Temporal lib.
 */

import "temporal-spec/global";
import type { Temporal as TemporalModule } from "temporal-polyfill";
import type { TimeWithOffset } from "../../src/dialects/pg/temporal.ts";

const instant = Temporal.Instant.from("2020-01-01T00:00:00.123456Z");
const shown = instant.toString({ fractionalSecondDigits: 6 });
const sample: TimeWithOffset = {
  time: Temporal.PlainTime.from("00:00:00"),
  offset: "+00:00",
};
const fromModule: TemporalModule.Instant = instant;

void shown;
void sample;
void fromModule;
