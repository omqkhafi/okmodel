/**
 * Startup catalog check.
 *
 * The fast path compares two hashes and returns. History and
 * `.okm/catalog.json` load only when those hashes differ. A hash read from
 * `catalog.hash` requires that JSON file; a missing file or a hash that does
 * not match is OKM1027. Concurrent loads share one parse.
 */

import { catalogFileText } from "../contracts/catalog/document.js";
import type { Catalog } from "../contracts/catalog/types.js";
import type { DriverPool, ExecuteOptions } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import type { QuerySchema } from "../dialects/pg/model.js";
import { artifactDir, readText } from "./artifact-file.js";

export { artifactDir } from "./artifact-file.js";

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
 * @param namespace - Schema that stores `okm_history`. `public` stays unqualified
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
  namespace = "public",
): Promise<void> {
  const code = await codeHash(schema, source);
  if (code.hash === recordedHash) return;
  const { loadOnce } = await import("./catalog-cache.js");
  if (code.artifact !== undefined) {
    const artifact = code.artifact;
    await loadOnce(`text\0${artifact.hash}`, async () => {
      const { loadTrustedCatalog } = await import("../contracts/catalog/document.js");
      loadTrustedCatalog(artifact.text, artifact.hash);
    });
  } else if (code.fromFile) {
    const dir = artifactDir(source.catalogDir);
    await loadOnce(`file\0${dir}\0${code.hash}`, async () => {
      const text = await readText(`${dir}/catalog.json`);
      if (text === undefined) {
        throw new OkmError("OKM1027", `${dir}/catalog.json is missing.`, {
          fix: {
            summary:
              "Run okm build so catalog.json matches catalog.hash. connect does not rebuild the catalog from the schema.",
          },
        });
      }
      const { loadTrustedCatalog } = await import("../contracts/catalog/document.js");
      loadTrustedCatalog(text, code.hash);
    });
  }
  const { assertDrift } = await import("./drift-detail.js");
  await assertDrift(pool, code.hash, recordedHash, options, namespace);
}

async function codeHash(
  schema: QuerySchema,
  source: { readonly catalog?: CatalogArtifact; readonly catalogDir?: string },
): Promise<{
  readonly hash: string;
  readonly artifact?: CatalogArtifact;
  /** True when the hash came from `catalog.hash`, so the JSON file is required on a mismatch. */
  readonly fromFile: boolean;
}> {
  if (source.catalog !== undefined) {
    return { hash: source.catalog.hash, artifact: source.catalog, fromFile: false };
  }
  const listed = await readHashFile(source.catalogDir);
  if (listed !== undefined) return { hash: listed, fromFile: true };
  const { catalogHash } = await import("../contracts/catalog/document.js");
  return { hash: catalogHash(schemaCatalog(schema)), fromFile: false };
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
  const hash = catalogFileText(text, "catalog.hash").trim();
  return hash.length === 0 ? undefined : hash;
}
