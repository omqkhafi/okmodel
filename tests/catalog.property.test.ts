import { expect, test } from "bun:test";
import * as fc from "fast-check";

import {
  POSTGRES_IDENTIFIER_MAX_BYTES,
  OkmError,
  catalog,
  catalogHash,
  column,
  deterministicName,
  fitIdentifier,
  isReservedIdentifier,
  parseCatalog,
  resolveNamespace,
  serializeCatalog,
  staticNamespace,
  table,
  templateNamespace,
  utf8ByteLength,
  type NamePurpose,
} from "../src/contracts/index.js";

const provenance = { origin: "file" as const, name: "db/schema.ts" };

const ident = fc
  .stringMatching(/^[a-z][a-z0-9_]{0,10}$/)
  .filter((name) => !isReservedIdentifier(name));

const limit = fc.integer({ min: 12, max: POSTGRES_IDENTIFIER_MAX_BYTES });

const purpose: fc.Arbitrary<NamePurpose> = fc.constantFrom(
  "primaryKey",
  "unique",
  "foreignKey",
  "check",
  "index",
);

test("hash is stable when inputs are reordered", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(ident, { minLength: 1, maxLength: 6 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      (names, seed) => {
        const objects = names.flatMap((name) => {
          const namespace = staticNamespace("public");
          const parent = { namespace, name };
          return [
            table({ namespace, name, provenance }),
            column({
              parent,
              name: "id",
              dataType: "uuid",
              nullable: false,
              provenance,
            }),
          ];
        });
        const forward = catalog(objects);
        const backward = catalog(shuffle(objects, seed));
        expect(serializeCatalog(forward)).toBe(serializeCatalog(backward));
        expect(catalogHash(forward)).toBe(catalogHash(backward));
      },
    ),
    { numRuns: 40 },
  );
});

test("identities in one catalog are unique", () => {
  fc.assert(
    fc.property(fc.uniqueArray(ident, { minLength: 1, maxLength: 5 }), (names) => {
      const namespace = staticNamespace("public");
      const built = catalog(names.map((name) => table({ namespace, name, provenance })));
      expect(built.objects).toHaveLength(names.length);
    }),
    { numRuns: 40 },
  );

  fc.assert(
    fc.property(ident, (name) => {
      const namespace = staticNamespace("public");
      const object = table({ namespace, name, provenance });
      expect(() => catalog([object, table({ namespace, name, provenance })])).toThrow(OkmError);
      try {
        catalog([object, object]);
      } catch (error) {
        expect(error).toBeInstanceOf(OkmError);
        if (error instanceof OkmError) {
          expect(error.code).toBe("OKM1023");
        }
      }
    }),
    { numRuns: 20 },
  );
});

test("template identity round-trips without a concrete name", () => {
  fc.assert(
    fc.property(
      fc
        .tuple(fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/), fc.constantFrom("", "_x", "_data"))
        .map(([head, tail]) => `${head}_{id}${tail}`)
        .filter((pattern) => pattern.includes("{id}")),
      ident,
      (pattern, name) => {
        const namespace = templateNamespace(pattern);
        const built = catalog([table({ namespace, name, provenance })]);
        const text = serializeCatalog(built);
        const parsed = parseCatalog(text);
        const stored = parsed.objects[0]?.identity;
        expect(stored?.kind).toBe("table");
        if (stored?.kind !== "table" || stored.namespace.form !== "template") {
          throw new Error("expected a template table");
        }
        expect(stored.namespace.pattern).toBe(pattern);
        expect(text).not.toContain(resolveNamespace(namespace, "acme"));
        expect(serializeCatalog(parsed)).toBe(text);
      },
    ),
    { numRuns: 40 },
  );
});

test("serialize and parse round-trip", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.uniqueArray(ident, { minLength: 1, maxLength: 4 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      (useTemplate, names, seed) => {
        const namespace = useTemplate
          ? templateNamespace("tenant_{id}")
          : staticNamespace("public");
        const objects = names.flatMap((name) => {
          const ref = { namespace, name };
          return [
            table({ namespace, name, provenance }),
            column({ parent: ref, name: "id", dataType: "text", nullable: false, provenance }),
          ];
        });
        const built = catalog(shuffle(objects, seed));
        const text = serializeCatalog(built);
        const parsed = parseCatalog(text);
        expect(serializeCatalog(parsed)).toBe(text);
        expect(catalogHash(parsed)).toBe(catalogHash(built));
      },
    ),
    { numRuns: 40 },
  );
});

test("deterministic names stay within the length limit", () => {
  fc.assert(
    fc.property(ident, ident, purpose, limit, (parent, nameKey, kind, bytes) => {
      const name = deterministicName({ parent, purpose: kind, nameKey, limit: bytes });
      expect(utf8ByteLength(name)).toBeLessThanOrEqual(bytes);
      expect(deterministicName({ parent, purpose: kind, nameKey, limit: bytes })).toBe(name);
    }),
    { numRuns: 80 },
  );

  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z]{64,80}$/),
      fc.stringMatching(/^[a-z]{64,80}$/),
      (left, right) => {
        fc.pre(left !== right);
        const fittedLeft = fitIdentifier(left);
        const fittedRight = fitIdentifier(right);
        expect(fittedLeft).not.toBe(fittedRight);
        expect(utf8ByteLength(fittedLeft)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
        expect(utf8ByteLength(fittedRight)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
      },
    ),
    { numRuns: 40 },
  );
});

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed >>> 0;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swap = state % (index + 1);
    const current = copy[index];
    const other = copy[swap];
    if (current !== undefined && other !== undefined) {
      copy[index] = other;
      copy[swap] = current;
    }
  }
  return copy;
}
