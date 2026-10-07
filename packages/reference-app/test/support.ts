/**
 * Shared setup for the reference app tests.
 *
 * `okmodel` is imported by name, the way an application imports it. In the
 * repository that name is the `node_modules/okmodel` link to the root; in the
 * tarball job it is the packed package extracted under this directory. The
 * link is made before any app module loads, so app modules are imported
 * dynamically.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createIsolatedDatabase, openPostgres } from "../../harness/src/postgres.js";
import { linkSelfPackage } from "../../../scripts/link-package.js";

/** The reference app directory. */
export const appDir = join(import.meta.dir, "..");

/** The application role from `okmodel.config.ts`. */
export const APP_ROLE = "ref_app";

/** Password the infrastructure sets for {@link APP_ROLE}. OKModel stores none. */
const APP_PASSWORD = "ref_app";

/**
 * Loads the app modules and the OKModel entries the tests use.
 *
 * @returns The modules, after `okmodel` resolves by name
 */
export async function loadApp() {
  linkSelfPackage();
  const [db, useCases, schema, testing, postgresjs] = await Promise.all([
    import("../src/db.js"),
    import("../src/use-cases.js"),
    import("../src/schema.js"),
    import("okmodel/testing"),
    import("okmodel/pg/postgresjs"),
  ]);
  return {
    ...db,
    ...useCases,
    app: schema.default,
    testing: testing.testing,
    open: postgresjs.open,
  };
}

/**
 * The directory of the `okmodel` package the app resolves.
 *
 * @returns The package root, holding `package.json` and `dist/okm.js`
 */
export function okmodelRoot(): string {
  linkSelfPackage();
  let dir = dirname(fileURLToPath(import.meta.resolve("okmodel/migrate")));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("okmodel package.json not found");
    dir = parent;
  }
  return dir;
}

/** What one `okm` run printed. */
export type OkmRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

/**
 * Runs the `okm` bin of the resolved package.
 *
 * @param args - Arguments after `okm`
 * @param env - Target URLs for `okmodel.config.ts`
 * @param cwd - Project directory. Defaults to the app
 * @returns Exit code and output
 */
export async function okm(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string = appDir,
): Promise<OkmRun> {
  const proc = Bun.spawn(["bun", join(okmodelRoot(), "dist", "okm.js"), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Runs `okm` and fails with its output when it exits non-zero.
 *
 * @param args - Arguments after `okm`
 * @param env - Target URLs
 * @param cwd - Project directory. Defaults to the app
 * @returns Standard output
 */
export async function okmOk(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd?: string,
): Promise<string> {
  const run = await okm(args, env, cwd);
  if (run.code !== 0) {
    throw new Error(`okm ${args.join(" ")} exited ${String(run.code)}\n${run.stdout}${run.stderr}`);
  }
  return run.stdout;
}

/**
 * Creates an empty database and provisions it from the head snapshot.
 *
 * @returns The database and what `okm migrate apply` printed
 */
export async function previewDatabase() {
  const database = await createIsolatedDatabase();
  const applied = await okmOk(["migrate", "apply", "--target", "preview"], {
    PREVIEW_DATABASE_URL: database.url,
  });
  return { database, applied };
}

/**
 * Does what the infrastructure does for the application role on one database.
 *
 * The plan creates the role without a password, and the role needs `SELECT` on
 * `okm_meta` for the startup check (a documented known limit).
 *
 * @param url - Database URL as the migration role
 * @returns The same database as the application role
 */
export async function appRoleUrl(url: string): Promise<string> {
  const sql = openPostgres(url);
  try {
    password ??= sql
      .unsafe(`alter role ${APP_ROLE} with password '${APP_PASSWORD}'`)
      .then(() => {});
    await password;
    await sql.unsafe(`grant select on okm_meta to ${APP_ROLE}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return asRole(url);
}

/**
 * The one `ALTER ROLE ... PASSWORD` of this process.
 *
 * Roles belong to the cluster. Two concurrent `ALTER ROLE` statements on one
 * role fail with `tuple concurrently updated`, so parallel jobs share this.
 */
let password: Promise<void> | undefined;

/**
 * Rewrites a URL to log in as the application role.
 *
 * @param url - Any URL on the cluster
 * @returns The URL with the application role's credentials
 */
export function asRole(url: string): string {
  const next = new URL(url);
  next.username = APP_ROLE;
  next.password = APP_PASSWORD;
  return next.href;
}

/**
 * A project directory with only the first `count` migrations of the app.
 *
 * Used to put a database at an older migration before the rehearsal.
 *
 * @param count - Migrations to copy
 * @returns The directory. Remove it with `rmSync`
 */
export function projectAt(count: number): string {
  const scratch = join(appDir, ".tmp");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "project-"));
  mkdirSync(join(dir, "migrations"));
  cpSync(join(appDir, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(appDir, "okmodel.config.ts"), join(dir, "okmodel.config.ts"));
  const names = ["0001_init", "0002_public_id", "0003_drop_share_token"].slice(0, count);
  for (const name of names) {
    for (const suffix of [".sql", ".catalog.json"]) {
      cpSync(join(appDir, "migrations", name + suffix), join(dir, "migrations", name + suffix));
    }
  }
  return dir;
}

/**
 * Removes a directory made by {@link projectAt}.
 *
 * @param dir - The directory
 */
export function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
