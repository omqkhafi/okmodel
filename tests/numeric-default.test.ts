/**
 * A numeric default given as a JavaScript number (N-122).
 *
 * `schema()` throws OKM1210. `describe()` is not reached with a TypeError.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { describe } from "../src/tooling/migrate/schema-api.js";

test("t.numeric().default(0) from JavaScript is OKM1210", () => {
  const build = () =>
    schema({
      tables: [
        table("p", {
          id: t.text().primaryKey(),
          price: t.numeric().default(0 as unknown as string),
        }),
      ],
    });
  expect(build).toThrow(OkmError);
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1210");
    expect(error).not.toBeInstanceOf(TypeError);
  }
});

test("a numeric default spelled as a string still describes", () => {
  const built = schema({
    tables: [
      table("p", {
        id: t.text().primaryKey(),
        price: t.numeric().default("0"),
      }),
    ],
  });
  expect(describe(built).catalog.objects.some((object) => object.kind === "column")).toBe(true);
});
