/**
 * Startup catalog check.
 *
 * The fast path compares two hashes. History, catalog JSON, and
 * {@link loadTrustedCatalog} load only when those hashes differ.
 */

import type { Catalog } from "../contracts/catalog/types.js";
import type { DriverPool, ExecuteOptions } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import type { QuerySchema } from "../dialects/pg/model.js";

/** Build artifact `okm build` wrote. */
export type CatalogArtifact = {
  readonly text: string;
  readonly hash: string;
};

/**
 * Compares the code's catalog hash with the hash already read from `okm_meta`.
 *
 * Equal hashes return without reading history. A difference loads the
 * compatibility check.
 *
 * @param pool - The pool `connect` is checking
 * @param schema - The caller's schema. Its catalog is read only when no artifact hash is available
 * @param recordedHash - Hash from the startup query
 * @param source - Optional build artifact, or a directory that contains one
 * @param options - Cancellation and deadline for the history query
 */
export async function assertCompatible(
  pool: DriverPool,
  schema: QuerySchema,
  recordedHash: string,
  source: {
    readonly catalog?: CatalogArtifact;
    readonly catalogDir?: string;
  },
  options: ExecuteOptions | undefined,
): Promise<void> {
  const code = await codeHash(schema, source);
  if (code.hash === recordedHash) return;
  if (code.artifact !== undefined) {
    const { loadTrustedCatalog } = await import("../contracts/catalog/document.js");
    loadTrustedCatalog(code.artifact.text, code.artifact.hash);
  } else {
    const artifact = await readCatalogFile(source.catalogDir);
    if (artifact !== undefined) {
      const { loadTrustedCatalog } = await import("../contracts/catalog/document.js");
      loadTrustedCatalog(artifact.text, artifact.hash);
    }
  }
  const { assertDrift } = await import("./drift-detail.js");
  await assertDrift(pool, code.hash, recordedHash, options);
}

async function codeHash(
  schema: QuerySchema,
  source: { readonly catalog?: CatalogArtifact; readonly catalogDir?: string },
): Promise<{ readonly hash: string; readonly artifact?: CatalogArtifact }> {
  if (source.catalog !== undefined) return { hash: source.catalog.hash, artifact: source.catalog };
  const listed = await readHashFile(source.catalogDir);
  if (listed !== undefined) return { hash: listed };
  const { catalogHash } = await import("../contracts/catalog/document.js");
  return { hash: catalogHash(schemaCatalog(schema)) };
}

function schemaCatalog(schema: QuerySchema): Catalog {
  const value: unknown = Reflect.get(schema, "catalog");
  if (typeof value !== "object" || value === null || !("objects" in value)) {
    throw new OkmError("OKM1520", "The schema has no catalog to compare.", {
      fix: {
        summary: "Pass the schema() result to connect, or a catalog artifact from okm build.",
      },
    });
  }
  return value as Catalog;
}

async function readHashFile(catalogDir: string | undefined): Promise<string | undefined> {
  const text = await readText(`${artifactDir(catalogDir)}/catalog.hash`);
  if (text === undefined) return undefined;
  const hash = text.trim();
  return hash.length === 0 ? undefined : hash;
}

async function readCatalogFile(
  catalogDir: string | undefined,
): Promise<CatalogArtifact | undefined> {
  const dir = artifactDir(catalogDir);
  const hash = await readHashFile(catalogDir);
  const text = await readText(`${dir}/catalog.json`);
  if (hash === undefined || text === undefined) return undefined;
  return { text, hash };
}

function artifactDir(catalogDir: string | undefined): string {
  if (catalogDir !== undefined) return catalogDir.replace(/\/$/, "");
  const cwd = globalThis.process?.cwd?.() ?? ".";
  return `${cwd}/.okm`;
}

/**
 * Reads an optional build artifact.
 *
 * The runtime layer cannot import `node:fs`. Bun and Node expose a file read
 * without that import. A missing file is `undefined`.
 */
async function readText(path: string): Promise<string | undefined> {
  const bun = (
    globalThis as {
      Bun?: {
        file: (path: string) => { exists: () => Promise<boolean>; text: () => Promise<string> };
      };
    }
  ).Bun;
  if (bun !== undefined) {
    const file = bun.file(path);
    if (!(await file.exists())) return undefined;
    return file.text();
  }
  const loader = (
    globalThis as {
      process?: { getBuiltinModule?: (name: string) => NodeFs };
    }
  ).process?.getBuiltinModule;
  if (loader === undefined) return undefined;
  try {
    return await loader("node:fs/promises").readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

type NodeFs = {
  readFile: (path: string, encoding: "utf8") => Promise<string>;
};
