/**
 * A hidden or sensitive codec error keeps a message that does not contain the value.
 *
 * OKM1210 for a missing Temporal global names no submitted value. A message that
 * includes the value is still replaced.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { date, schema, smallint, table, text } from "../src/dialects/pg/index.js";
import { explainWrite } from "../src/runtime/write.js";

const marked = table("marked", {
  id: text().primaryKey(),
  at: date().sensitive(),
  n: smallint().sensitive(),
  plain: date(),
});

const app = schema({ tables: [marked] });

test("a sensitive date keeps the Temporal message, and a sensitive integer does not keep the value", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Temporal");
  Object.defineProperty(globalThis, "Temporal", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    const sensitive = await rejection(
      explainWrite(app, "insert", "marked", { id: "1", at: "2020-01-01" }, {}, {}),
    );
    expect(sensitive.code).toBe("OKM1210");
    expect(sensitive.message).toContain("globalThis.Temporal");
    expect(sensitive.message).toContain("polyfill");
    expect(sensitive.message).not.toContain("2020-01-01");
    expect(sensitive.message).not.toBe("Field at was rejected.");

    const open = await rejection(
      explainWrite(app, "insert", "marked", { id: "1", plain: "2020-01-01" }, {}, {}),
    );
    expect(open.code).toBe("OKM1210");
    expect(open.message).toContain("globalThis.Temporal");

    const number = await rejection(
      explainWrite(app, "insert", "marked", { id: "1", n: 40_000 }, {}, {}),
    );
    expect(number.code).toBe("OKM1210");
    expect(number.message).toBe("Field n was rejected.");
    expect(number.message).not.toContain("40000");
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "Temporal");
    else Object.defineProperty(globalThis, "Temporal", descriptor);
  }
});

async function rejection(value: unknown): Promise<OkmError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}
