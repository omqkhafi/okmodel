/**
 * Drizzle casing detection: flag, builders, scan, then none.
 */

import { expect, test } from "bun:test";

import {
  casingsInSource,
  chooseDrizzleCasing,
  effectiveColumnName,
  fallbackCamel,
  fallbackSnake,
  inferBuilderCasing,
} from "../src/tooling/migrate/drizzle-casing.js";

const spell = { snake: fallbackSnake, camel: fallbackCamel };

test("an empty Drizzle name is not replaced with the property", () => {
  expect(effectiveColumnName("", false, "firstName", "snake_case", spell)).toBeUndefined();
  expect(effectiveColumnName("", true, "firstName", "none", spell)).toBeUndefined();
  expect(effectiveColumnName("'", true, "'", "snake_case", spell)).toBeUndefined();
  expect(effectiveColumnName("firstName", true, "firstName", "snake_case", spell)).toBe(
    "first_name",
  );
  expect(effectiveColumnName("first_name", true, "firstName", "snake_case", spell)).toBe(
    "first_name",
  );
  expect(effectiveColumnName("email", false, "emailAddress", "snake_case", spell)).toBe("email");
});

test("builder votes come from keyAsName columns, and a scan conflict is none", () => {
  expect(
    inferBuilderCasing(
      [
        { property: "id", name: "id", keyAsName: true },
        { property: "firstName", name: "first_name", keyAsName: true },
        { property: "emailAddress", name: "email", keyAsName: false },
      ],
      spell,
    ),
  ).toBe("snake_case");
  expect(
    inferBuilderCasing(
      [
        { property: "firstName", name: "first_name", keyAsName: true },
        { property: "first_name", name: "firstName", keyAsName: true },
      ],
      spell,
    ),
  ).toBe("mixed");
  const source = `
    // casing: "camelCase"
    export const db = { casing: "snake_case" };
    snakeCase.table("users", {});
  `;
  expect(casingsInSource(source)).toEqual(["snake_case"]);
  expect(casingsInSource(`casing: "snake_case"; casing: "camelCase";`)).toEqual([
    "snake_case",
    "camelCase",
  ]);
  expect(
    chooseDrizzleCasing({
      flag: "camelCase",
      inferred: "snake_case",
      scan: { casing: "snake_case", conflict: false },
    }).casing,
  ).toBe("camelCase");
  const mixed = chooseDrizzleCasing({
    flag: undefined,
    inferred: "mixed",
    scan: { casing: undefined, conflict: false },
  });
  expect(mixed.casing).toBe("none");
  expect(mixed.finding).toContain("more than one casing");
  const conflict = chooseDrizzleCasing({
    flag: undefined,
    inferred: undefined,
    scan: { casing: undefined, conflict: true },
  });
  expect(conflict.casing).toBe("none");
  expect(conflict.finding).toContain("more than one casing");
});
