/**
 * Optional build files under `.okm`.
 *
 * The runtime layer cannot import `node:fs`. Bun and Node expose a file read
 * without that import. A missing file is `undefined`.
 */

/**
 * Directory of `catalog.hash` and `catalog.json`.
 *
 * A trailing `/` or `\` is removed so the joined file name is one path.
 *
 * A missing or throwing `process.cwd` uses `./.okm`. Node keeps `<cwd>/.okm`.
 *
 * @param catalogDir - Directory the caller passed, or the default `.okm`
 * @returns The directory, without a trailing slash
 */
export function artifactDir(catalogDir: string | undefined): string {
  if (catalogDir !== undefined) return catalogDir.replace(/[/\\]+$/, "");
  let cwd = ".";
  try {
    cwd = globalThis.process?.cwd?.() ?? ".";
  } catch {
    cwd = ".";
  }
  return `${cwd}/.okm`;
}

/**
 * Reads an optional build artifact.
 *
 * @param path - File path
 * @returns The text, or `undefined` when the file is missing
 */
export async function readText(path: string): Promise<string | undefined> {
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
