/**
 * The fast CI tier shortens property runs. The full tier leaves the count alone.
 */

import { expect, test } from "bun:test";

import { gateRuns } from "./gate-property.js";

test("gateRuns reads OKM_PROPERTY_SCALE", () => {
  const previous = process.env.OKM_PROPERTY_SCALE;
  process.env.OKM_PROPERTY_SCALE = "0.25";
  try {
    expect(gateRuns(80)).toBe(20);
    expect(gateRuns(1)).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.OKM_PROPERTY_SCALE;
    else process.env.OKM_PROPERTY_SCALE = previous;
  }
});
