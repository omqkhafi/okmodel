/**
 * A foreign ledger name is OKM1899 before any migration step.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import {
  ledgerForeign,
  ledgerNameTaken,
  ledgerRequiredColumns,
} from "../src/tooling/migrate/ledger.js";

const steps = ledgerRequiredColumns("okm_steps") ?? [];

test("a ledger relation is foreign when it is not that table", () => {
  expect(steps).toContain("kind");
  expect(ledgerForeign("okm_steps", "r", ["id"])).toBe(true);
  expect(ledgerForeign("okm_steps", "v", steps)).toBe(true);
  expect(ledgerForeign("okm_steps", "r", steps)).toBe(false);
  expect(ledgerForeign("okm_steps", "r", [...steps, "extra"])).toBe(false);
  expect(ledgerForeign("notes", "r", ["id"])).toBe(false);
  expect(
    ledgerForeign("okm_history", "r", ["migration_id", "step_index", "class", "catalog_hash"]),
  ).toBe(true);
});

test("OKM1899 names the schema and the table", () => {
  const error = caught(() => ledgerNameTaken('say "hi"', "okm_steps"));
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.code).toBe("OKM1899");
  expect(error.kind).toBe("invalid");
  expect(error.message).toBe('Another table owns the name "say ""hi"""."okm_steps".');
  expect(error.message.toLowerCase()).toContain("another table owns the name");
});

function caught(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
