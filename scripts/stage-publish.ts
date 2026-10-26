/**
 * Stages the packed tarball with `npm stage publish`.
 *
 * npm 11.15.0 or newer and Node 22.14.0 or newer are required. Provenance is
 * requested explicitly. A prerelease version is staged under the `next` tag,
 * because npm refuses a prerelease without an explicit tag. That version is
 * read from the tarball's `package/package.json`, not from the checkout.
 * No npm token is read. Trusted publishing supplies the OIDC token.
 *
 *   bun ./scripts/stage-publish.ts ./packed/okmodel.tgz
 */

/** Oldest npm that implements `npm stage`. */
export const NPM_FLOOR = "11.15.0";

/** Oldest Node that trusted publishing accepts. */
export const NODE_FLOOR = "22.14.0";

/**
 * True when `actual` is older than `floor`.
 *
 * Numeric dot-separated prefixes are compared. A missing segment is zero.
 *
 * @param actual - Version the tool printed, such as `11.15.0`
 * @param floor - Minimum version, such as `11.15.0`
 * @returns True when `actual` is below `floor`
 */
export function versionBelow(actual: string, floor: string): boolean {
  const left = actual.trim().split(".");
  const right = floor.split(".");
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index++) {
    const part = left[index] ?? "0";
    const required = right[index] ?? "0";
    const have = Number.parseInt(part, 10);
    const need = Number.parseInt(required, 10);
    if (!Number.isInteger(have) || !Number.isInteger(need)) return true;
    if (have < need) return true;
    if (have > need) return false;
  }
  return false;
}

/**
 * Arguments for `npm stage publish` of one tarball.
 *
 * The tarball must be an explicit `./` or absolute path. npm treats a bare
 * path as a git shorthand.
 *
 * @param tarball - Packed file, such as `./packed/okmodel.tgz`
 * @param version - `package.json` version inside that tarball
 * @returns The argv, including `npm`
 */
export function stagePublishCommand(tarball: string, version: string): readonly string[] {
  if (!tarball.startsWith("./") && !tarball.startsWith("/")) {
    throw new Error(
      `npm stage publish needs a path starting with ./ or /, not ${tarball}. A bare path is a git shorthand.`,
    );
  }
  const args = ["npm", "stage", "publish", tarball, "--access", "public", "--provenance"];
  if (version.includes("-")) args.push("--tag", "next");
  return args;
}

/**
 * `version` from `package/package.json` inside a packed tarball.
 *
 * The checkout manifest can differ from the tarball the publish job staged.
 * The tag follows the packed file.
 *
 * @param tarball - Packed file, such as `./packed/okmodel.tgz`
 * @returns The version string
 */
export function readPackedVersion(tarball: string): string {
  const proc = Bun.spawnSync(["tar", "-xOzf", tarball, "package/package.json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `could not read package/package.json from ${tarball}\n${proc.stderr.toString()}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(proc.stdout.toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${tarball} package.json is not valid JSON: ${message}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error(`${tarball} package.json has no version`);
  }
  const version = parsed.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${tarball} package.json version is not a string`);
  }
  return version;
}

function toolVersion(command: string): string {
  const proc = Bun.spawnSync([command, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${command} --version failed\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

if (import.meta.main) {
  if (process.env.NPM_TOKEN !== undefined || process.env.NODE_AUTH_TOKEN !== undefined) {
    console.error("Refusing to stage with an npm token. Trusted publishing uses OIDC.");
    process.exit(1);
  }
  const tarball = process.argv[2];
  if (tarball === undefined || tarball.length === 0) {
    console.error("usage: bun ./scripts/stage-publish.ts ./packed/okmodel.tgz");
    process.exit(1);
  }
  const node = process.versions.node;
  const npm = toolVersion("npm");
  if (versionBelow(node, NODE_FLOOR) || versionBelow(npm, NPM_FLOOR)) {
    console.error(
      `Refusing to stage. Need Node >= ${NODE_FLOOR} and npm >= ${NPM_FLOOR}. Have Node ${node} and npm ${npm}.`,
    );
    process.exit(1);
  }
  const args = stagePublishCommand(tarball, readPackedVersion(tarball));
  const proc = Bun.spawnSync([...args], { stdout: "inherit", stderr: "inherit" });
  process.exit(proc.exitCode ?? 1);
}
