/**
 * Capabilities page, support markers, and the migration step table.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  capabilityDocProblems,
  proofPasses,
  renderCapabilitiesPage,
  renderSupportLine,
  stepRows,
  supportLabel,
  supportMarkerProblems,
  supportRegion,
} from "../scripts/docs-capabilities.js";
import { ensurePackedDocs } from "../scripts/docs-pack.js";
import { repoRoot } from "../scripts/root.js";
import { STEP_KINDS } from "../src/tooling/migrate/classify.js";
import type { FeatureEntry } from "../src/tooling/capabilities/types.js";

const root = repoRoot();
ensurePackedDocs(root);

test("a missing proof is unverified and is not called native", () => {
  const entry: FeatureEntry = { support: "native", proof: "proof:missing", since: "18" };
  expect(proofPasses("type.demo", entry, new Set())).toBe(false);
  expect(supportLabel(entry, false)).toBe("unverified");
  const page = renderCapabilitiesPage({
    version: "0.10.0-next.1",
    registry: { "type.demo": entry },
    titles: new Set(),
  });
  expect(page).toContain("| `type.demo` | unverified | 18 | unverified (`proof:missing`) |");
  expect(page).not.toContain("| native |");
  expect(page).toContain('okmVersion: "0.10.0"');
  expect(page).toContain("codes: []");
  expect(renderSupportLine("type.demo", entry, new Set())).toBe(
    "Postgres: unverified. Proof `proof:missing` is not a passing title.",
  );
});

test("emulated and refused rows use the registry text when the proof passes", () => {
  const emulated: FeatureEntry = {
    support: "emulated",
    cost: "one extra read",
    proof: "proof:demo",
  };
  const refused: FeatureEntry = {
    support: "refused",
    alternative: "Use a uuid column",
    code: "OKM1860",
    proof: "proof:demo",
  };
  const titles = new Set(["proof:demo", "refusal:type.refused"]);
  expect(supportLabel(emulated, true)).toBe("emulated. one extra read");
  expect(supportLabel(refused, true)).toBe("refused. Use a uuid column (OKM1860)");
  const page = renderCapabilitiesPage({
    version: "0.10.0",
    registry: { "query.demo": emulated, "type.refused": refused },
    titles,
  });
  expect(page).toContain("| `query.demo` | emulated. one extra read | — | passes (`proof:demo`) |");
  expect(page).toContain(
    "| `type.refused` | refused. Use a uuid column (OKM1860) | — | passes (`proof:demo`) |",
  );
  expect(page).toContain("codes: [OKM1860]");
  const missingRefusal = new Set(["proof:demo"]);
  expect(proofPasses("type.refused", refused, missingRefusal)).toBe(false);
  expect(supportLabel(refused, false)).toBe("unverified");
});

test("support markers fail when the block or the key disagrees", () => {
  const entry: FeatureEntry = { support: "native", proof: "proof:demo" };
  const titles = new Set(["proof:demo"]);
  const registry = { "schema.core": entry };
  const wrong = "<!-- support: schema.core -->\nnative on every version\n<!-- /support -->\n";
  expect(supportMarkerProblems(wrong, "docs/x.md", registry, titles).join("\n")).toContain(
    "does not match",
  );
  const unknown = "<!-- support: missing.key -->\nPostgres: native.\n<!-- /support -->\n";
  expect(supportMarkerProblems(unknown, "docs/x.md", registry, titles).join("\n")).toContain(
    "unknown feature",
  );
  const open = "<!-- support: schema.core -->\n";
  expect(supportMarkerProblems(open, "docs/x.md", registry, titles).join("\n")).toContain(
    "no closing marker",
  );
  const line = renderSupportLine("schema.core", entry, titles);
  const good = `<!-- support: schema.core -->\n${line}\n<!-- /support -->\n`;
  expect(supportMarkerProblems(good, "docs/x.md", registry, titles)).toEqual([]);
});

test("step rows follow the planner kinds and the probe function", () => {
  const rows = stepRows(root);
  expect(rows.map((row) => row.kind)).toEqual([...STEP_KINDS]);
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  expect(byKind.get("create-table")?.transactional).toBe("yes");
  expect(byKind.get("create-table")?.probe).toBe("no");
  expect(byKind.get("create-index")?.transactional).toBe("no when CONCURRENTLY");
  expect(byKind.get("create-index")?.probe).toBe("when CONCURRENTLY");
  expect(byKind.get("create-index")?.resume).toContain("partial");
  expect(byKind.get("drop-index")?.transactional).toBe("no when CONCURRENTLY");
  expect(byKind.get("drop-index")?.probe).toBe("when CONCURRENTLY");
  expect(byKind.get("add-enum-value")?.transactional).toBe("no");
  expect(byKind.get("add-enum-value")?.probe).toBe("yes");
  expect(byKind.get("add-constraint")?.probe).toBe("yes");
  expect(byKind.get("add-constraint")?.transactional).toBe("yes");
  expect(byKind.get("validate-constraint")?.probe).toBe("yes");
  expect(byKind.get("backfill-expand")?.resume).toContain("okm_backfill");
  expect(byKind.get("backfill-contract")?.resume).toContain("okm_backfill");
  expect(byKind.get("backfill-expand")?.transactional).toBe("no");
  expect(byKind.get("raw-sql")?.transactional).toContain("unless");
  expect(byKind.get("raw-sql")?.resume).toContain("concurrent index");
  expect(byKind.get("set-not-null")?.transactional).toBe("yes");
});

test("the generated capabilities page, markers, and step table match the registry", () => {
  expect(capabilityDocProblems(root)).toEqual([]);
  const pages = [
    ["docs/compatibility.md", "type.uuidv7"],
    ["docs/migration-failure.md", "steps.resumable"],
    ["docs/testing.md", "tooling.testing"],
    ["docs/migrate-check.md", "tooling.scratchReplay"],
    ["docs/observer-events.md", "writeObserver.unit"],
    ["docs/observer-events.md", "writeObserver.keys"],
    ["docs/observer-events.md", "writeObserver.rowCount"],
    ["docs/observer-events.md", "queryObserver.timing"],
  ] as const;
  for (const [file, key] of pages) {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).toContain(supportRegion(key, root).trimEnd());
  }
  const failure = readFileSync(join(root, "docs/migration-failure.md"), "utf8");
  expect(failure).toContain("<!-- steps -->");
  expect(failure).toContain("`add-enum-value`");
  expect(failure).toContain("`create-index`");
});
