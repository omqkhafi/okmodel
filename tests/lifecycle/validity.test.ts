/**
 * Every initial model the grammar emits is a schema the library accepts.
 *
 * `schema()` runs when the file loads. `generate init` plans the first
 * migration and fails on an error finding. Neither step connects.
 */

import fc from "fast-check";
import { expect, test } from "bun:test";

import { openLifecycleProject } from "../../packages/harness/src/lifecycle-project.js";
import { generateProject } from "../../src/tooling/migrate/project.js";
import { repoRoot } from "../../scripts/root.js";
import { lifecycleCaseArb } from "./grammar.js";
import { renderSchema } from "./render.js";

const root = repoRoot();

test("every generated initial model passes schema() and generate init", async () => {
  await fc.assert(
    fc.asyncProperty(lifecycleCaseArb, async (item) => {
      const project = openLifecycleProject(root, "lifecycle-valid");
      try {
        project.writeConfig("postgres://okm:okm@127.0.0.1:9/okm");
        project.writeSchema(renderSchema(item.initial, root));
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
