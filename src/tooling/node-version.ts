/**
 * Node version `okm` needs in order to load `okmodel.config.ts`.
 *
 * Node 22.18 unflags type stripping. Bun loads TypeScript itself, so the
 * check does not apply when `bun --bun` is the runtime.
 */

/**
 * Whether `version` can strip types in a `.ts` config.
 *
 * @param version - `process.version`, such as `v22.18.0`
 * @returns `true` for Node 22.18 and every newer major
 */
export function nodeSupportsConfigTypes(version: string): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 22) return true;
  if (major < 22) return false;
  return minor >= 18;
}

/**
 * Startup text when this process cannot load a TypeScript config.
 *
 * @param version - `process.version`
 * @param bunRuntime - `true` when Bun is running the process
 * @returns The stderr line, or `undefined` when the process can continue
 */
export function nodeStartupMessage(version: string, bunRuntime: boolean): string | undefined {
  if (bunRuntime || nodeSupportsConfigTypes(version)) return undefined;
  return `okm needs Node.js >=22.18 to load a .ts config (type stripping). This process is ${version}. Run bun --bun okm to use the Bun runtime.\n`;
}
