/**
 * `instanceof OkmError` matches a second copy of the class (K-1).
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";

test("OkmError from another module copy still matches instanceof", async () => {
  const copy = await import(`../src/contracts/error.js?copy=${crypto.randomUUID()}`);
  const Other = copy.OkmError;
  expect(Other).not.toBe(OkmError);

  const here = new OkmError("driver", "here");
  const there = new Other("driver", "there");
  expect(here instanceof OkmError).toBe(true);
  expect(there instanceof OkmError).toBe(true);
  expect(here instanceof Other).toBe(true);
  expect(there instanceof Other).toBe(true);
  expect(here instanceof Error).toBe(true);
  expect(there instanceof Error).toBe(true);
  expect(new Error("plain") instanceof OkmError).toBe(false);
  expect(new Error("plain") instanceof Other).toBe(false);
  expect((null as unknown) instanceof OkmError).toBe(false);

  const caught: unknown = there;
  expect(caught instanceof OkmError).toBe(true);
  if (!(caught instanceof OkmError)) throw new Error("expected the brand");
  expect(caught.message).toBe("there");
  expect(caught.code).toBe("driver");
  expect(OkmError.from(there)).toBe(there);
  expect(OkmError.is(there, "driver")).toBe(true);
});
