/**
 * `okm protect add`, `remove`, and `list`.
 *
 * The store is a union with project `protected: true`. Removing the config
 * flag does not remove a fingerprint. `remove` requires a terminal.
 */

import { OkmError } from "../../contracts/error.js";
import { hostDbFingerprint } from "./fingerprint.js";
import { asProject, type ProjectContext } from "./paths.js";
import { selectTarget } from "./policy.js";
import { loadConfig } from "./project.js";
import { addFingerprint, readProtectedStore, removeFingerprint } from "./protected-store.js";

/** One fingerprint in command JSON. `identity` stays null. */
export type ProtectIdentity = {
  readonly hostDb: string;
  readonly identity: null;
};

/** `okm protect add` data. */
export type ProtectAddData = ProtectIdentity & {
  readonly reason: "store fingerprint";
};

/** `okm protect remove` data. */
export type ProtectRemoveData = ProtectIdentity & {
  readonly removed: boolean;
};

/** `okm protect list` data. */
export type ProtectListData = {
  readonly fingerprints: readonly ProtectIdentity[];
};

const TERMINAL_FIX =
  "Open a terminal for this invocation. A terminal is friction, not proof of a human.";

/**
 * Records the selected target's fingerprint.
 *
 * @param project - Project directory or context
 * @param targetName - `--target`, when the command passed one
 * @param storePath - Store file. The CLI passes the user path
 * @returns The fingerprint. The URL is not included
 */
export async function addProtectedTarget(
  project: string | ProjectContext,
  targetName: string | undefined,
  storePath: string,
): Promise<ProtectAddData> {
  const target = selectTarget(await loadConfig(asProject(project)), targetName, { storePath });
  const hostDb = hostDbFingerprint(target.host, target.port, target.database);
  addFingerprint(storePath, hostDb);
  return { hostDb, identity: null, reason: "store fingerprint" };
}

/**
 * Removes the selected target's fingerprint.
 *
 * A missing terminal is exit 4 before the config is read. The fingerprint
 * is deleted even when the project config no longer says `protected: true`.
 *
 * @param project - Project directory or context
 * @param targetName - `--target`, when the command passed one
 * @param storePath - Store file
 * @param tty - Whether stdin is a terminal
 * @returns The fingerprint and whether the store held it
 */
export async function removeProtectedTarget(
  project: string | ProjectContext,
  targetName: string | undefined,
  storePath: string,
  tty: boolean,
): Promise<ProtectRemoveData> {
  if (tty !== true) {
    throw new OkmError(
      "OKM1859",
      "protect remove is blocked when there is no terminal (store fingerprint).",
      { kind: "forbidden", fix: { summary: TERMINAL_FIX } },
    );
  }
  const target = selectTarget(await loadConfig(asProject(project)), targetName, { storePath });
  const hostDb = hostDbFingerprint(target.host, target.port, target.database);
  const removed = removeFingerprint(storePath, hostDb);
  return { hostDb, identity: null, removed };
}

/**
 * Lists store fingerprints. A corrupt store fails closed.
 *
 * @param storePath - Store file
 * @returns Fingerprints in store order
 */
export function listProtectedTargets(storePath: string): ProtectListData {
  return { fingerprints: listFingerprints(readProtectedStore(storePath).fingerprints) };
}

function listFingerprints(fingerprints: readonly string[]): readonly ProtectIdentity[] {
  return fingerprints.map((hostDb) => ({ hostDb, identity: null }));
}
