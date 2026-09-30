import { expect, test } from "bun:test";

import { moduleSpecifiers } from "../scripts/specifiers.js";

test("module specifiers keep type-only imports and drop comments and strings", () => {
  const source = `
    import "node:fs";
    import type { A } from "./type-only";
    import { type B } from "./inline-type";
    import { value } from "./value";
    export type { C } from "./export-type";
    export { d } from "./export-value";
    export * as ns from "./star";
    export function f() { return import("./inside"); }
    const text = "import { a } from './nope'";
    // import "commented";
  `;
  const specs = [...moduleSpecifiers(source)].sort();
  expect(specs).toEqual(
    [
      "./export-type",
      "./export-value",
      "./inline-type",
      "./inside",
      "./star",
      "./type-only",
      "./value",
      "node:fs",
    ].sort(),
  );
});
