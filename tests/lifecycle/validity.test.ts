/**
 * Every initial model the grammar emits is a schema the library accepts.
 *
 * `schema()` runs when the file loads. `generate init` plans the first
 * migration and fails on an error finding. Neither step connects.
 */

import fc from "fast-check";
import { expect, test } from "bun:test";

import { OkmError } from "../../src/contracts/error.js";
import { openLifecycleProject } from "../../packages/harness/src/lifecycle-project.js";
import { generateProject } from "../../src/tooling/migrate/project.js";
import { repoRoot } from "../../scripts/root.js";
import { lifecycleCaseArb } from "./grammar.js";
import { renderSchema } from "./render.js";

const root = repoRoot();

test("the grammar draws snake, camel, collisions, and names over 63 bytes", () => {
  const casings = new Set<string>();
  const stresses = new Set<string>();
  fc.assert(
    fc.property(lifecycleCaseArb, (item) => {
      casings.add(item.initial.casing);
      stresses.add(item.initial.stress ?? "none");
      if (item.initial.stress === "collide") expect(item.initial.casing).not.toBe("omit");
      if (item.initial.stress === "long") {
        const long = item.initial.tables.some((table) =>
          table.columns.some((column) => Buffer.byteLength(column.name) > 63),
        );
        expect(long).toBe(true);
      }
    }),
    { numRuns: 400, seed: 20261024 },
  );
  expect([...casings].sort()).toEqual(["camel", "omit", "snake"]);
  expect(stresses.has("collide")).toBe(true);
  expect(stresses.has("long")).toBe(true);
});

test("every generated initial model passes schema() and generate init", async () => {
  await fc.assert(
    fc.asyncProperty(lifecycleCaseArb, async (item) => {
      const project = openLifecycleProject(root, "lifecycle-valid");
      try {
        project.writeConfig("postgres://okm:okm@127.0.0.1:9/okm");
        project.writeSchema(renderSchema(item.initial, root));
        const stress = item.initial.stress ?? "none";
        if (stress !== "none") {
          let caught: unknown;
          try {
            await generateProject(project.cwd, "init", []);
          } catch (error) {
            caught = error;
          }
          expect(OkmError.from(caught).code).toBe(stress === "collide" ? "OKM1023" : "OKM1122");
          return;
        }
        const written = await generateProject(project.cwd, "init", []);
        expect(written).toBeDefined();
        const errors = (written?.findings ?? []).filter((finding) => finding.severity === "error");
        if (errors.length > 0) {
          throw new Error(
            `${errors.map((finding) => `${finding.code} ${finding.reason}`).join("\n")}\n${renderSchema(item.initial, root)}`,
          );
        }
      } finally {
        project.close();
      }
    }),
    { numRuns: 200, seed: 20261024 },
  );
}, 120_000);
