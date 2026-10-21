/**
 * The gated startup graph is the static import graph with dynamic imports stubbed.
 *
 * A lazy chunk added behind an existing `import()` must not move that number.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { repoRoot } from "../scripts/root.js";
import {
  CONNECT_ENTRIES,
  measureStartup,
  measureStubbedStartup,
  startupChunkNames,
  startupGraphSources,
} from "../scripts/size.js";

const root = repoRoot();

test("stubbed startup bytes ignore a lazy chunk and stay stable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-size-startup-"));
  const entry = join(dir, "entry.ts");
  const lazy = join(dir, "lazy.ts");
  writeFileSync(join(dir, "static.ts"), "export const marker = 1;\n");
  writeFileSync(
    entry,
    'import { marker } from "./static.ts";\nexport const value = marker;\nexport function load() { return import("./lazy.ts"); }\n',
  );
  writeFileSync(
    lazy,
    `export const payload = ${JSON.stringify("LAZY".repeat(2000))};\nexport function nested() { return import("./nested.ts"); }\n`,
  );
  writeFileSync(join(dir, "nested.ts"), "export const nested = 1;\n");
  try {
    const first = await measureStubbedStartup(dir, "entry.ts", "entry.js");
    const second = await measureStubbedStartup(dir, "entry.ts", "entry.js");
    expect(second.minBytes).toBe(first.minBytes);
    expect(second.gzipBytes).toBe(first.gzipBytes);
    expect(first.sources).toEqual(["entry.ts", "static.ts"]);
    const full = await startupGraphSources(dir, "entry.ts", "entry.js");
    expect(full).toEqual(["entry.ts", "static.ts"]);
    writeFileSync(
      lazy,
      `${readFileSync(lazy, "utf8")}export function more() { return import("./extra.ts"); }\n`,
    );
    writeFileSync(
      join(dir, "extra.ts"),
      `export const extra = ${JSON.stringify("MORE".repeat(2000))};\n`,
    );
    const after = await measureStubbedStartup(dir, "entry.ts", "entry.js");
    expect(after.minBytes).toBe(first.minBytes);
    expect(after.gzipBytes).toBe(first.gzipBytes);
    const reference = measureStartup(dir, "entry.ts", "entry.js", [], undefined, false);
    expect(reference.totalMinBytes).toBeGreaterThan(first.minBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cold import loads the startup chunks and not the lazy ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-size-cold-"));
  const out = join(dir, "out");
  mkdirSync(out);
  writeFileSync(join(dir, "static.ts"), "export const marker = 1;\n");
  writeFileSync(
    join(dir, "entry.ts"),
    'import { marker } from "./static.ts";\nexport const value = marker;\nexport function load() { return import("./lazy.ts"); }\n',
  );
  writeFileSync(join(dir, "lazy.ts"), "export const payload = 1;\n");
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        join(dir, "entry.ts"),
        "--target",
        "node",
        "--minify",
        "--splitting",
        "--outdir",
        out,
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    const chunks = startupChunkNames(out, "entry.js");
    const href = pathToFileURL(join(out, "entry.js")).href;
    const source = [
      'import { registerHooks } from "node:module";',
      "const loaded = [];",
      "registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });",
      `await import(${JSON.stringify(href)});`,
      'const files = loaded.filter((url) => url.startsWith("file:")).map((url) => decodeURIComponent(new URL(url).pathname.split("/").pop()));',
      'process.stdout.write(files.join("\\n"));',
    ].join("\n");
    const node = Bun.spawnSync(["node", "--input-type=module", "-e", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(node.exitCode).toBe(0);
    const loaded = node.stdout
      .toString()
      .split("\n")
      .filter((name) => name.endsWith(".js"))
      .sort();
    expect(loaded).toEqual([...chunks].sort());
    expect(loaded.some((name) => name.includes("lazy"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("stubbed sources match the full startup graph", async () => {
  const graphs = [
    ["scripts/app-startup.ts", "app-startup.js", ["postgres"]] as const,
    ...CONNECT_ENTRIES.map((entry) => [entry.entry, entry.file, entry.external] as const),
  ];
  for (const [entry, file, external] of graphs) {
    const full = await startupGraphSources(root, entry, file, external);
    const stub = await startupGraphSources(root, entry, file, external, true);
    expect(stub, entry).toEqual(full);
  }
});
