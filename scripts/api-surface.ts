/**
 * Export names of a public entry, for the API snapshot.
 *
 * The snapshot lists every name. A new export fails the test until the
 * snapshot records its classification.
 */

import { readFileSync } from "node:fs";

/** One published subpath and the source file that is its entry. */
export const API_ENTRIES = [
  { subpath: "okmodel", file: "src/contracts/index.ts" },
  { subpath: "okmodel/internal", file: "src/contracts/internal.ts" },
  { subpath: "okmodel/ids", file: "src/runtime/ids/index.ts" },
  { subpath: "okmodel/safety", file: "src/runtime/safety/index.ts" },
  { subpath: "okmodel/traits", file: "src/runtime/traits/index.ts" },
  { subpath: "okmodel/tenancy", file: "src/runtime/tenancy/index.ts" },
  { subpath: "okmodel/pg", file: "src/dialects/pg/index.ts" },
  { subpath: "okmodel/pg/postgresjs", file: "src/runtime/pg/postgresjs.ts" },
  { subpath: "okmodel/pg/pglite", file: "src/runtime/pg/pglite.ts" },
  { subpath: "okmodel/pg/pg", file: "src/runtime/pg/pg.ts" },
  { subpath: "okmodel/pg/bun", file: "src/runtime/pg/bun.ts" },
  { subpath: "okmodel/migrate", file: "src/tooling/migrate/index.ts" },
] as const;

/** How stable an export is. */
export type ApiKind = "stable" | "experimental" | "internal";

/** One classified export. */
export type ApiExport = {
  readonly name: string;
  readonly kind: ApiKind;
};

/**
 * Names a source entry exports, including types.
 *
 * @param source - TypeScript source of one entry
 * @returns Sorted export names
 */
export function exportNames(source: string): readonly string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const names = new Set<string>();
  for (const match of stripped.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    const body = match[1] ?? "";
    for (const part of body.split(",")) {
      const cleaned = part.replace(/\btype\b/g, "").trim();
      if (cleaned.length === 0) continue;
      const sides = cleaned.split(/\s+as\s+/);
      const name = (sides[1] ?? sides[0])?.trim();
      if (name !== undefined && name.length > 0) names.add(name);
    }
  }
  for (const match of stripped.matchAll(/export\s+\*\s+as\s+(\w+)/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  for (const match of stripped.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g,
  )) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

/**
 * Classifies one export.
 *
 * `okmodel/internal` is entirely internal. A public subpath is stable.
 * `domain` is experimental until 0.3.
 *
 * @param subpath - Package subpath
 * @param name - Export name
 * @returns The classification
 */
export function classifyExport(subpath: string, name: string): ApiKind {
  if (subpath === "okmodel/internal") return "internal";
  if (subpath === "okmodel/pg" && name === "domain") return "experimental";
  return "stable";
}

/**
 * Reads and classifies one entry.
 *
 * @param source - Entry source
 * @param subpath - Package subpath
 * @returns Exports in name order
 */
export function classifyEntry(source: string, subpath: string): readonly ApiExport[] {
  return exportNames(source).map((name) => ({ name, kind: classifyExport(subpath, name) }));
}

/**
 * Reads an entry file from disk.
 *
 * @param path - Absolute path
 * @returns The source
 */
export function readEntry(path: string): string {
  return readFileSync(path, "utf8");
}
