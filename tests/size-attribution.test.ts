/**
 * Per-module bytes for a gated graph match `scripts/size.ts` on a fixture.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocateShares,
  attributionDelta,
  attributeGraph,
  repoGraphSpecs,
  totalProblems,
  type GraphAttribution,
  type GraphSpec,
} from "../scripts/size-attribution.js";

test("gated graph ids follow the size.ts gates", () => {
  const ids = repoGraphSpecs().map((spec) => spec.id);
  expect(ids[0]).toBe("runtime");
  expect(ids[1]).toBe("app");
  expect(ids).toContain("connect:src/runtime/pg/postgresjs.ts");
  expect(ids).toContain("connect:src/runtime/pg/neon.ts");
  expect(ids).toContain("adapter:src/adapters/pg/postgresjs.ts");
  expect(ids).toContain("adapter:src/adapters/pg/pglite.ts");
});

test("gzip shares sum to the total and ties go to the earlier index", () => {
  expect([...allocateShares(10, [1, 1, 1])]).toEqual([4, 3, 3]);
  expect([...allocateShares(5, [1, 3])].reduce((sum, share) => sum + share, 0)).toBe(5);
  expect([...allocateShares(0, [4, 1])]).toEqual([0, 0]);
});

test("stubbed attribution matches size.ts and omits the lazy module", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-attr-"));
  writeFileSync(join(dir, "static.ts"), "export const marker = 1;\n");
  writeFileSync(
    join(dir, "entry.ts"),
    'import { marker } from "./static.ts";\nexport const value = marker;\nexport function load() { return import("./lazy.ts"); }\n',
  );
  writeFileSync(
    join(dir, "lazy.ts"),
    `export const payload = ${JSON.stringify("LAZY".repeat(400))};\n`,
  );
  const spec: GraphSpec = {
    id: "fixture",
    kind: "startup",
    entry: "entry.ts",
    file: "entry.js",
    external: [],
    runtimeEntry: "entry.ts",
  };
  try {
    const graph = await attributeGraph(dir, spec);
    expect(totalProblems(graph)).toEqual([]);
    expect(graph.minBytes).toBe(graph.oracleMinBytes);
    expect(graph.oracleGzipBytes).toBe(graph.gzipBytes);
    const paths = graph.modules.map((mod) => mod.path);
    expect(paths).toContain("entry.ts");
    expect(paths).toContain("static.ts");
    expect(paths).not.toContain("lazy.ts");
    expect(graph.modules.reduce((sum, mod) => sum + mod.minBytes, 0)).toBe(graph.minBytes);
    expect(graph.modules.reduce((sum, mod) => sum + mod.gzipBytes, 0)).toBe(graph.gzipBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime attribution matches size.ts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-attr-rt-"));
  writeFileSync(
    join(dir, "entry.ts"),
    "export const value = 1;\nexport function keep(n: number) { return n + 1; }\n",
  );
  const spec: GraphSpec = {
    id: "runtime",
    kind: "runtime",
    entry: "entry.ts",
    file: "runtime.js",
    external: [],
    runtimeEntry: "entry.ts",
  };
  try {
    const graph = await attributeGraph(dir, spec);
    expect(totalProblems(graph)).toEqual([]);
    expect(graph.minBytes).toBe(graph.oracleMinBytes);
    expect(graph.oracleGzipBytes).toBe(graph.gzipBytes);
    expect(graph.modules.some((mod) => mod.path === "entry.ts" && mod.minBytes > 0)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a module delta is a report and a drifted total is a problem", () => {
  const current: GraphAttribution = {
    id: "runtime",
    entry: "entry.ts",
    kind: "runtime",
    minBytes: 10,
    gzipBytes: 6,
    oracleMinBytes: 10,
    oracleGzipBytes: 6,
    modules: [{ path: "a.ts", minBytes: 10, gzipBytes: 6 }],
  };
  const deltas = attributionDelta([current], {
    graphs: [
      {
        id: "runtime",
        entry: "entry.ts",
        kind: "runtime",
        minBytes: 11,
        gzipBytes: 7,
        modules: [
          { path: "a.ts", minBytes: 8, gzipBytes: 4 },
          { path: "b.ts", minBytes: 3, gzipBytes: 3 },
        ],
      },
    ],
  });
  expect(
    deltas.map((delta) => `${delta.path} ${String(delta.beforeMin)} ${String(delta.afterMin)}`),
  ).toEqual(["b.ts 3 null", "a.ts 8 10"]);
  expect(totalProblems(current)).toEqual([]);
  expect(totalProblems({ ...current, minBytes: current.minBytes + 100 }).length).toBeGreaterThan(0);
});
