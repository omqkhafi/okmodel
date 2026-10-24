/**
 * User-level protected-target fingerprints.
 *
 * The file is `$XDG_CONFIG_HOME/okm/protected.json`, or
 * `~/.config/okm/protected.json` when that variable is unset. Windows uses
 * `%APPDATA%\okm\protected.json`. The file holds hashes, not URLs. There is
 * no environment variable that points this path somewhere else.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { OkmError } from "../../contracts/error.js";

const HEX = /^[0-9a-f]{64}$/;

/** One store on disk. `version` is 1. */
export type ProtectedStore = {
  readonly version: 1;
  readonly fingerprints: readonly string[];
};

/** Parts the path is built from. Tests pass these instead of the process. */
export type StorePathInput = {
  readonly platform: string;
  readonly home: string;
  readonly xdgConfigHome?: string | undefined;
  readonly appData?: string | undefined;
};

/**
 * Default store path for this process.
 *
 * @returns Absolute path of `protected.json`
 */
export function protectedStorePath(): string {
  return storePathFor({
    platform: process.platform,
    home: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    appData: process.env.APPDATA,
  });
}

/**
 * Store path for an explicit platform and home.
 *
 * @param input - Platform, home, and the optional config roots
 * @returns Absolute path of `protected.json`
 */
export function storePathFor(input: StorePathInput): string {
  if (input.platform === "win32") {
    const base =
      input.appData !== undefined && input.appData.length > 0
        ? input.appData
        : join(input.home, "AppData", "Roaming");
    return join(base, "okm", "protected.json");
  }
  const base =
    input.xdgConfigHome !== undefined && input.xdgConfigHome.length > 0
      ? input.xdgConfigHome
      : join(input.home, ".config");
  return join(base, "okm", "protected.json");
}

/**
 * Reads the store. A missing file is empty. Anything else that is not
 * version 1 with lowercase hex fingerprints fails closed.
 *
 * @param path - Store file
 * @returns The store
 */
export function readProtectedStore(path: string): ProtectedStore {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { version: 1, fingerprints: [] };
    throw corruptStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corruptStore();
  }
  if (typeof parsed !== "object" || parsed === null) throw corruptStore();
  const record = parsed as { readonly version?: unknown; readonly fingerprints?: unknown };
  if (record.version !== 1 || !Array.isArray(record.fingerprints)) throw corruptStore();
  const fingerprints: string[] = [];
  for (const item of record.fingerprints) {
    if (typeof item !== "string" || !HEX.test(item)) throw corruptStore();
    fingerprints.push(item);
  }
  return { version: 1, fingerprints };
}

/**
 * Writes the store, replacing the file.
 *
 * @param path - Store file
 * @param fingerprints - Lowercase hex digests
 */
export function writeProtectedStore(path: string, fingerprints: readonly string[]): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, fingerprints }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/**
 * Adds one fingerprint. A digest that is already present stays once.
 *
 * @param path - Store file
 * @param hostDb - Lowercase hex digest
 */
export function addFingerprint(path: string, hostDb: string): void {
  const current = readProtectedStore(path);
  if (current.fingerprints.includes(hostDb)) return;
  writeProtectedStore(path, [...current.fingerprints, hostDb]);
}

/**
 * Removes one fingerprint. Every copy of that digest is removed.
 *
 * @param path - Store file
 * @param hostDb - Lowercase hex digest
 * @returns Whether the store held it
 */
export function removeFingerprint(path: string, hostDb: string): boolean {
  const current = readProtectedStore(path);
  const next = current.fingerprints.filter((item) => item !== hostDb);
  if (next.length === current.fingerprints.length) return false;
  writeProtectedStore(path, next);
  return true;
}

function corruptStore(): OkmError {
  return new OkmError("OKM1859", "The protection store could not be read.", {
    kind: "forbidden",
    fix: {
      summary:
        "Restore version 1 and a list of fingerprint strings. A terminal is friction, not proof of a human.",
    },
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
