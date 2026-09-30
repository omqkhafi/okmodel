import { expect, test } from "bun:test";

import { catalogHash, canonicalJson, objectHash, sha256, type Json } from "./canonical.js";
import { sampleCatalog } from "./sample.js";
import { staticNamespace, templateNamespace, type CatalogObject } from "./object.js";

test("canonical JSON ignores object key order", () => {
  const random = mulberry32(11);
  for (let trial = 0; trial < 40; trial += 1) {
    const value = randomJson(random, 0);
    expect(canonicalJson(value)).toBe(canonicalJson(reverseKeys(value)));
    expect(sha256(canonicalJson(value))).toBe(sha256(canonicalJson(reverseKeys(value))));
  }
});

test("object and catalog hashes ignore field order and object order", () => {
  const namespace = staticNamespace("app");
  const left = textColumn("type-first");
  const right = textColumn("null-first");
  expect(objectHash(left)).toBe(objectHash(right));
  expect(objectHash(left)).toBe(objectHash(left));

  const objects = sampleCatalog(namespace);
  const reversed = [...objects].reverse();
  expect(catalogHash(objects)).toBe(catalogHash(reversed));
  expect(catalogHash(objects)).toBe(catalogHash(objects));
});

test("provenance, owner, and namespace templates change the hash", () => {
  const namespace = staticNamespace("app");
  const objects = sampleCatalog(namespace);
  const first = objects[0];
  if (first === undefined) throw new Error("empty sample");
  const changed: CatalogObject = {
    ...first,
    provenance: { source: "spike", detail: "other" },
  };
  expect(objectHash(changed)).not.toBe(objectHash(first));
  expect(catalogHash(sampleCatalog(templateNamespace("tenant_{id}")))).not.toBe(
    catalogHash(sampleCatalog(staticNamespace("tenant_demo"))),
  );
});

function textColumn(order: "type-first" | "null-first"): CatalogObject {
  const namespace = staticNamespace("app");
  const definition =
    order === "type-first" ? { type: "text", nullable: false } : { nullable: false, type: "text" };
  return {
    kind: "column",
    identity: { kind: "column", namespace, parent: "tasks", name: "title" },
    owner: "managed",
    definition,
    dependencies: [{ identity: { kind: "table", namespace, name: "tasks" } }],
    provenance: { source: "spike" },
  };
}

function randomJson(random: () => number, depth: number): Json {
  const roll = random();
  if (depth > 2 || roll < 0.4) {
    if (roll < 0.2) return null;
    if (roll < 0.3) return random() < 0.5;
    if (roll < 0.4) return Math.floor(random() * 20);
    return `s${String(Math.floor(random() * 50))}`;
  }
  if (roll < 0.7) {
    const length = Math.floor(random() * 4);
    const items: Json[] = [];
    for (let index = 0; index < length; index += 1) items.push(randomJson(random, depth + 1));
    return items;
  }
  const record: Record<string, Json> = {};
  const count = 1 + Math.floor(random() * 4);
  for (let index = 0; index < count; index += 1) {
    record[`k${String(index)}`] = randomJson(random, depth + 1);
  }
  return record;
}

function reverseKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => reverseKeys(item));
  if (!isRecord(value)) return value;
  const reversed: Record<string, Json> = {};
  for (const key of Object.keys(value).reverse()) {
    const item = value[key];
    if (item !== undefined) reversed[key] = reverseKeys(item);
  }
  return reversed;
}

function isRecord(value: Json): value is { readonly [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
