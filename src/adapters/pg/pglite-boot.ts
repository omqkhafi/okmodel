/**
 * PGlite startup, loaded from {@link import("./pglite.ts").open}.
 *
 * Contrib bundles have to be passed before wasm init. `open` loads this
 * module with a dynamic import so the connect entry does not carry it.
 */

import { PGlite, type QueryOptions } from "@electric-sql/pglite";

type NoticeEvent = {
  severity?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
};

/**
 * Loads declared contrib bundles. A name PGlite does not ship is skipped.
 *
 * `CREATE EXTENSION` still runs later, and a missing bundle fails there.
 *
 * @param names - Extension names from the catalog
 * @returns Bundles keyed by name, or `undefined` when none loaded
 */
export async function loadContrib(
  names: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  const loaded: Record<string, unknown> = {};
  for (const name of names) {
    try {
      const mod = (await import(`@electric-sql/pglite/contrib/${name}`)) as Record<string, unknown>;
      const ext = mod[name];
      if (ext !== undefined) loaded[name] = ext;
    } catch {
      // plpgsql and other builtins are not contrib bundles.
    }
  }
  return Object.keys(loaded).length === 0 ? undefined : loaded;
}

/**
 * Starts one PGlite database.
 *
 * @param dataDir - Data directory, including `memory://`
 * @param onNotice - Receives server notices for the statement in flight
 * @param extensions - Contrib bundles, omitted when the schema declares none
 * @returns The database, reused query options, and the wire failure mapper
 */
export async function openPglite(
  dataDir: string,
  onNotice: (notice: NoticeEvent) => void,
  extensions: Record<string, unknown> | undefined,
): Promise<{
  readonly db: PGlite;
  readonly options: QueryOptions;
  readonly fail: (error: unknown) => Promise<unknown>;
}> {
  const wire = await import("./pglite-wire.js");
  const db = new PGlite({
    dataDir,
    parsers: wire.parsers,
    serializers: wire.serializers,
    ...(extensions === undefined ? {} : { extensions: extensions as never }),
  });
  await db.waitReady;
  return {
    db,
    options: {
      rowMode: "array",
      parsers: wire.parsers,
      serializers: wire.serializers,
      onNotice,
    },
    fail: (error) => wire.fail(error),
  };
}
