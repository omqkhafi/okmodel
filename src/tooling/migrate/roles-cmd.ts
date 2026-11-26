/**
 * `okm roles apply`, `set-password`, `status`, and `generate`.
 *
 * Passwords stay in the process. They are not written to a plan, a log, JSON,
 * or a file that git does not ignore. An existing role's password is not changed
 * by `apply`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { open } from "../../adapters/pg/postgresjs.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import {
  normalizeRoles,
  type NormalizedRole,
  type RoleMembership,
} from "../../dialects/pg/role/config.js";
import type { DriverPool } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import type { MigrateConfig } from "./config.js";
import { detectPooler } from "./pooler.js";
import { resolvePooler } from "./pooler-probe.js";
import { durationPhrase, estimateMs } from "./weight.js";
import { ask } from "../prompt.js";
import { scramVerifier } from "./scram.js";

/** How one login attempt ended. */
export type LoginOutcome =
  | { readonly result: "ok" }
  | { readonly result: "wrong" }
  | { readonly result: "unknown"; readonly detail: string }
  | { readonly result: "pooler-username" }
  | { readonly result: "skipped" };

/** One role in `okm roles status --json`. No URL and no password. */
export type RoleStatus = {
  readonly key: string;
  readonly name: string;
  readonly scope: "managed" | "unmanaged";
  readonly exists: boolean;
  readonly attributes: Readonly<Record<string, string | boolean | number | null>>;
  readonly envSet: boolean;
  readonly login: LoginOutcome["result"];
  readonly loginDetail?: string;
  readonly memberships: readonly string[];
  readonly strict?: readonly string[];
};

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Classifies one login error. There is no retry.
 *
 * @param error - The driver error
 * @param pooled - The shared detector said the URL is pooled
 * @returns The outcome
 */
export function classifyLogin(error: unknown, pooled: boolean): LoginOutcome {
  const code = readCode(error);
  const message = error instanceof Error ? error.message : "";
  if (code === "28P01") return { result: "wrong" };
  if (code === "08P01" && /sasl/i.test(message)) return { result: "wrong" };
  if (code === "XX000" && /ENOIDENTIFIER/i.test(message)) return { result: "pooler-username" };
  if (pooled) return { result: "unknown", detail: "cannot verify through a pooler" };
  return { result: "unknown", detail: code ?? "the server did not accept the login" };
}

/**
 * Creates missing roles and aligns declared limits. Never sets a password on a role that exists.
 *
 * @param config - Project config
 * @param adminEnv - Variable name holding the admin URL
 * @param flags - Password flags
 * @param terminal - Whether stdin is a terminal
 * @returns Human text with no secret
 */
export async function applyRoles(
  config: MigrateConfig,
  adminEnv: string,
  flags: PasswordFlags,
  terminal: boolean,
): Promise<string> {
  const roles = requireRoles(config);
  const pool = open({ url: adminUrl(adminEnv), max: 1 });
  try {
    const version = await serverVersion(pool);
    assertMembershipVersion(roles, version);
    const lines: string[] = [];
    for (const role of roles) {
      const exists = await roleExists(pool, role.name);
      if (!exists) {
        await createRole(pool, role, flags, terminal);
        lines.push(`created ${role.name}`);
        await grantMemberships(pool, role);
        continue;
      }
      await alignLimits(pool, role);
      await grantMemberships(pool, role);
      lines.push(`exists ${role.name}`);
    }
    return `${lines.join("\n")}\n`;
  } finally {
    await pool.close();
  }
}

/**
 * Sets one role's password from its URL. The only password change.
 *
 * @param config - Project config
 * @param roleKey - Config key or SQL name
 * @param adminEnv - Variable name holding the admin URL
 * @param flags - Password flags
 * @param terminal - Whether stdin is a terminal
 * @returns Human text with no secret
 */
export async function setRolePassword(
  config: MigrateConfig,
  roleKey: string,
  adminEnv: string,
  flags: PasswordFlags,
  terminal: boolean,
): Promise<string> {
  const roles = requireRoles(config);
  const role = roles.find((entry) => entry.key === roleKey || entry.name === roleKey);
  if (role === undefined) {
    throw new OkmError("OKM1911", `Role ${roleKey} is not in roles.`, {
      kind: "not_found",
      fix: { summary: "Pass a roles key." },
    });
  }
  if (role.env === undefined) {
    throw new OkmError("OKM1912", `Role ${role.name} has no env, so it has no password.`, {
      fix: { summary: "Set env to the variable that holds the role URL." },
    });
  }
  const pool = open({ url: adminUrl(adminEnv), max: 1 });
  try {
    if (!(await roleExists(pool, role.name))) {
      throw new OkmError(
        "OKM1911",
        `Role ${role.name} does not exist. Run \`okm roles apply\` first.`,
        {
          kind: "not_found",
          fix: { summary: "Run okm roles apply --admin-env <NAME>." },
        },
      );
    }
    const secret = await passwordFor(role, flags, terminal);
    await sendPassword(pool, role.name, secret.password, flags.plain === true);
    return `password set for ${role.name}\n`;
  } finally {
    await pool.close();
  }
}

/**
 * Reads roles. Managed roles are checked. Unmanaged roles are listed and do not change the exit code by themselves.
 *
 * @param config - Project config
 * @param url - Migration URL. Not printed
 * @returns Status rows. `failed` is true when a managed role has an excess attribute
 */
export async function roleStatus(
  config: MigrateConfig,
  url: string,
): Promise<{ readonly rows: readonly RoleStatus[]; readonly failed: boolean }> {
  const roles = requireRoles(config);
  const pool = open({ url, max: 1 });
  try {
    const declared = new Set(roles.map((entry) => entry.name));
    const rows: RoleStatus[] = [];
    let failed = false;
    for (const role of roles) {
      const row = await oneStatus(pool, role, true);
      if ((row.strict?.length ?? 0) > 0) failed = true;
      rows.push(row);
    }
    const extra = await pool.execute(
      "select rolname from pg_roles where rolname !~ '^pg_' order by rolname",
    );
    for (const line of extra.rows) {
      const name = String(line[0] ?? "");
      if (declared.has(name) || name.length === 0) continue;
      rows.push(await oneStatus(pool, { key: name, name }, false));
    }
    return { rows, failed };
  } finally {
    await pool.close();
  }
}

/**
 * Prints random role URLs. Refuses `--json` and a non-terminal without `--env-file`.
 *
 * @param config - Project config
 * @param flags - Output flags
 * @param terminal - Whether stdout is a terminal
 * @param cwd - Directory for the gitignore check
 * @returns Empty when the URLs went to stderr or a file. Never a secret on the return value
 */
export function generateRoles(
  config: MigrateConfig,
  flags: PasswordFlags,
  terminal: boolean,
  cwd: string,
): string {
  if (flags.json === true) {
    throw new OkmError("OKM1912", "okm roles generate does not print passwords as JSON.", {
      fix: { summary: "Drop --json, or pass --env-file." },
    });
  }
  const roles = requireRoles(config).filter((entry) => entry.env !== undefined);
  const lines = roles.map((entry) => {
    const password = generatedPassword();
    const user = entry.name;
    return `${entry.env}=postgres://${user}:${password}@127.0.0.1:5432/app`;
  });
  if (flags.envFile !== undefined) {
    writeIgnored(flags.envFile, `${lines.join("\n")}\n`, cwd);
    return `wrote ${roles.length} role URL${roles.length === 1 ? "" : "s"}\n`;
  }
  if (!terminal) {
    throw new OkmError("OKM1912", "okm roles generate needs a terminal, or --env-file.", {
      fix: { summary: "Pass --env-file <path> that git ignores." },
    });
  }
  process.stderr.write(`${lines.join("\n")}\n`);
  return `printed ${roles.length} role URL${roles.length === 1 ? "" : "s"} once\n`;
}

/** Flags shared by the password commands. */
export type PasswordFlags = {
  readonly plain?: boolean;
  readonly acceptWeakPassword?: boolean;
  readonly generate?: boolean;
  readonly envFile?: string;
  readonly json?: boolean;
};

/**
 * One login, using the URL username exactly as written.
 *
 * @param url - Role URL. Not printed
 * @returns The outcome
 */
export async function probeLogin(url: string): Promise<LoginOutcome> {
  const hinted = detectPooler({ url });
  const pool = open({ url, max: 1 });
  let outcome: LoginOutcome;
  try {
    await pool.execute("select 1");
    outcome = { result: "ok" };
  } catch (error) {
    outcome = classifyLogin(error, hinted.pooled);
  } finally {
    await pool.close().catch(() => undefined);
  }
  if (outcome.result !== "unknown" || hinted.pooled) return outcome;
  const active = await resolvePooler(url).catch(() => hinted);
  if (!active.pooled) return outcome;
  return { result: "unknown", detail: "cannot verify through a pooler" };
}

/**
 * Doctor lines for the app role's settings and `statement_timeout`.
 *
 * @param pool - Migration connection
 * @param appRole - Application role name
 * @returns Lines, or an empty string
 */
export async function roleDoctorNotes(pool: DriverPool, appRole: string): Promise<string> {
  const settings = await pool.execute(
    `select unnest(s.setconfig) from pg_db_role_setting s
     join pg_roles r on r.oid = s.setrole
     where r.rolname = $1`,
    [appRole],
  );
  const lines = settings.rows.map(
    (row) =>
      `${String(row[0])} is set on ${appRole} and is not applied when the client switches role with SET ROLE`,
  );
  const timeout = await pool.execute("select current_setting('statement_timeout')");
  const shown = String(timeout.rows[0]?.[0] ?? "");
  const limit = timeoutMs(shown);
  if (shown.length > 0 && shown !== "0") {
    lines.push(
      `statement_timeout is ${shown}. A plan step whose duration estimate is larger than that is cancelled.`,
    );
  }
  if (limit !== undefined && limit > 0) {
    const sizes = await pool.execute(
      `select c.relname, c.reltuples::bigint from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema')
         and c.reltuples > 0`,
    );
    for (const row of sizes.rows) {
      const name = String(row[0] ?? "");
      const count = Number(row[1] ?? 0);
      if (name.length === 0 || !Number.isFinite(count) || count <= 0) continue;
      for (const weight of ["blocking", "rewrite"] as const) {
        const ms = estimateMs(weight, count);
        if (ms <= limit) continue;
        lines.push(
          `A ${weight} step on ${name} is estimated at ${durationPhrase(ms)}, longer than statement_timeout ${shown}.`,
        );
      }
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function timeoutMs(shown: string): number | undefined {
  const match = /^(\d+)\s*(ms|s|min|h)?$/i.exec(shown.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1_000;
  if (unit === "min") return amount * 60_000;
  return amount * 3_600_000;
}

async function oneStatus(
  pool: DriverPool,
  role: {
    readonly key: string;
    readonly name: string;
    readonly env?: string;
    readonly bypassRls?: string;
  },
  managed: boolean,
): Promise<RoleStatus> {
  const found = await pool.execute(
    `select rolcanlogin, rolsuper, rolcreaterole, rolbypassrls, rolconnlimit, rolvaliduntil::text
     from pg_roles where rolname = $1`,
    [role.name],
  );
  const row = found.rows[0];
  const exists = row !== undefined;
  const attributes = exists
    ? {
        login: truth(row[0]),
        superuser: truth(row[1]),
        createRole: truth(row[2]),
        bypassRls: truth(row[3]),
        connectionLimit: Number(row[4]),
        validUntil: row[5] === null || row[5] === undefined ? null : String(row[5]),
      }
    : {};
  const memberships = exists ? await membershipNames(pool, role.name) : [];
  let login: LoginOutcome = { result: "skipped" };
  if (managed && role.env !== undefined && process.env[role.env] !== undefined) {
    login = await probeLogin(process.env[role.env] ?? "");
  }
  const strict: string[] = [];
  if (managed && exists) {
    if (attributes.superuser === true) strict.push("superuser");
    if (attributes.createRole === true) strict.push("createrole");
    if (attributes.bypassRls === true && role.bypassRls === undefined) strict.push("bypassrls");
    if (memberships.includes("neon_superuser")) strict.push("neon_superuser");
    const owned = await pool.execute(
      `select c.relname from pg_class c join pg_roles r on r.oid = c.relowner
       where r.rolname = $1 and c.relkind = 'r' limit 1`,
      [role.name],
    );
    if (owned.rows.length > 0) strict.push("owns a table");
  }
  return {
    key: role.key,
    name: role.name,
    scope: managed ? "managed" : "unmanaged",
    exists,
    attributes,
    envSet:
      role.env !== undefined && process.env[role.env] !== undefined && process.env[role.env] !== "",
    login: login.result,
    ...(login.result === "unknown" || login.result === "pooler-username"
      ? {
          loginDetail:
            login.result === "pooler-username"
              ? "pooler username form (role.projectref)"
              : login.detail,
        }
      : {}),
    memberships,
    ...(managed && strict.length > 0 ? { strict } : {}),
  };
}

async function createRole(
  pool: DriverPool,
  role: NormalizedRole,
  flags: PasswordFlags,
  terminal: boolean,
): Promise<void> {
  await assertCanCreate(pool);
  const login = role.env !== undefined;
  let password: string | undefined;
  if (login) {
    const secret = await passwordFor(role, flags, terminal);
    password = flags.plain === true ? secret.password : scramVerifier(secret.password);
  }
  const attrs = [
    login ? "login" : "nologin",
    "nosuperuser",
    "nocreatedb",
    "nocreaterole",
    role.bypassRls !== undefined ? "bypassrls" : "nobypassrls",
  ].join(" ");
  try {
    if (password === undefined) {
      await pool.execute(`create role ${quoteIdent(role.name)} with ${attrs}`);
    } else {
      const built = await pool.execute(
        "select format('create role %I with %s password %L', $1::text, $2::text, $3::text)",
        [role.name, attrs, password],
      );
      await pool.execute(String(built.rows[0]?.[0] ?? ""));
    }
  } catch (error) {
    if (readCode(error) === "42710") return;
    throw error;
  }
  if (role.connectionLimit !== undefined || role.validUntil !== undefined) {
    await alignLimits(pool, role);
  }
}

async function alignLimits(pool: DriverPool, role: NormalizedRole): Promise<void> {
  if (role.connectionLimit === undefined && role.validUntil === undefined) return;
  await assertCanAlter(pool, role.name);
  if (role.connectionLimit !== undefined) {
    await pool.execute(
      `alter role ${quoteIdent(role.name)} connection limit ${String(role.connectionLimit)}`,
    );
  }
  if (role.validUntil !== undefined) {
    const built = await pool.execute(
      "select format('alter role %I valid until %L', $1::text, $2::text)",
      [role.name, role.validUntil],
    );
    await pool.execute(String(built.rows[0]?.[0] ?? ""));
  }
}

async function grantMemberships(pool: DriverPool, role: NormalizedRole): Promise<void> {
  const have = new Set(await membershipNames(pool, role.name));
  for (const member of role.memberOf ?? []) {
    const name = typeof member === "string" ? member : member.role;
    if (have.has(name)) continue;
    const options = membershipSql(member);
    await pool.execute(`grant ${quoteIdent(name)} to ${quoteIdent(role.name)}${options}`);
  }
}

function membershipSql(member: RoleMembership): string {
  if (typeof member === "string") return "";
  const parts: string[] = [];
  if (member.inherit !== undefined) parts.push(`inherit ${member.inherit ? "true" : "false"}`);
  if (member.set !== undefined) parts.push(`set ${member.set ? "true" : "false"}`);
  if (member.admin !== undefined) parts.push(`admin ${member.admin ? "true" : "false"}`);
  return parts.length === 0 ? "" : ` with ${parts.join(", ")}`;
}

function assertMembershipVersion(roles: readonly NormalizedRole[], version: number): void {
  if (version >= 160000) return;
  for (const role of roles) {
    for (const member of role.memberOf ?? []) {
      if (typeof member !== "string") {
        throw new OkmError(
          "OKM1914",
          `roles.${role.key}.memberOf options need PostgreSQL 16. This server is older. Nothing was changed.`,
          {
            kind: "forbidden",
            fix: { summary: "Use a role name, or run this on PostgreSQL 16 or later." },
          },
        );
      }
    }
  }
}

async function assertCanCreate(pool: DriverPool): Promise<void> {
  const row = await acting(pool);
  if (row.superuser || row.createRole) return;
  throw new OkmError("OKM1914", "This login cannot create roles. Nothing was changed.", {
    kind: "forbidden",
    fix: { summary: "Use a role with CREATEROLE." },
  });
}

async function assertCanAlter(pool: DriverPool, name: string): Promise<void> {
  const row = await acting(pool);
  if (row.superuser) return;
  const admin = await pool.execute(
    `select 1 from pg_auth_members m
     join pg_roles r on r.oid = m.roleid
     join pg_roles u on u.oid = m.member
     where r.rolname = $1 and u.rolname = current_user and m.admin_option`,
    [name],
  );
  if (admin.rows.length > 0) return;
  if (row.createRole) {
    throw new OkmError(
      "OKM1914",
      `Role ${row.name} has CREATEROLE and is not a superuser. PostgreSQL 16 does not let it alter a role it did not create. Nothing was changed.`,
      {
        kind: "forbidden",
        fix: {
          summary: "Run okm roles apply as the role that created this role, or as a superuser.",
        },
      },
    );
  }
  throw new OkmError("OKM1914", `This login cannot alter ${name}. Nothing was changed.`, {
    kind: "forbidden",
    fix: { summary: "Use a role with ADMIN OPTION on it." },
  });
}

async function sendPassword(
  pool: DriverPool,
  name: string,
  password: string,
  plain: boolean,
): Promise<void> {
  const secret = plain ? password : scramVerifier(password);
  const built = await pool.execute(
    "select format('alter role %I password %L', $1::text, $2::text)",
    [name, secret],
  );
  try {
    await pool.execute(String(built.rows[0]?.[0] ?? ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!plain && readCode(error) === "XX000" && /plaintext/i.test(message)) {
      throw new OkmError(
        "OKM1912",
        "This server only supports being given plaintext passwords. Re-run with --plain. The password was not changed.",
        {
          fix: {
            summary:
              "Pass --plain. A silent fallback would store md5 when password_encryption is md5.",
          },
        },
      );
    }
    throw error;
  }
}

async function passwordFor(
  role: NormalizedRole,
  flags: PasswordFlags,
  terminal: boolean,
): Promise<{ readonly password: string }> {
  const url = readEnv(role.env ?? "");
  const parsed = readUserPassword(url, role.name);
  if (LOCAL.has(parsed.host)) return { password: parsed.password };
  if (!weak(parsed.password)) return { password: parsed.password };
  if (flags.generate === true) {
    const password = generatedPassword();
    if (flags.envFile !== undefined) {
      writeIgnored(flags.envFile, `${role.env}=${replacePassword(url, password)}\n`, process.cwd());
    } else if (terminal) process.stderr.write(`${password}\n`);
    else {
      throw new OkmError("OKM1912", "A generated password needs a terminal or --env-file.", {
        fix: { summary: "Pass --env-file <path> that git ignores." },
      });
    }
    return { password };
  }
  if (flags.acceptWeakPassword === true) return { password: parsed.password };
  const message = `Password for ${role.name} is under 16 characters or duplicated. [c] continue anyway, [g] replace with a generated random password (shown once), [x] cancel`;
  if (!terminal) {
    throw new OkmError(
      "OKM1912",
      `${message}. Without a terminal pass --accept-weak-password or --generate with --env-file.`,
      {
        fix: { summary: "Pass --accept-weak-password or --generate --env-file <path>." },
      },
    );
  }
  const answer = (await ask(`${message}\n`)).toLowerCase();
  if (answer === "c") return { password: parsed.password };
  if (answer === "g") {
    const password = generatedPassword();
    process.stderr.write(`${password}\n`);
    return { password };
  }
  throw new OkmError("OKM1912", "Cancelled.", { fix: { summary: "Choose c or g, or cancel." } });
}

function readUserPassword(
  url: string,
  role: string,
): { readonly password: string; readonly host: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OkmError("OKM1912", `The URL in ${role}'s variable is not a postgres URL.`, {
      fix: { summary: "Set the variable to a postgres URL." },
    });
  }
  const raw = url.slice(url.indexOf("://") + 3);
  const at = raw.lastIndexOf("@");
  const userinfo = at < 0 ? raw : raw.slice(0, at);
  const colon = userinfo.indexOf(":");
  const rawPassword = colon < 0 ? "" : userinfo.slice(colon + 1);
  if (!/^([A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*$/.test(rawPassword)) {
    throw new OkmError(
      "OKM1912",
      "The password contains a character that is not percent-encoded. The role would get a different password than typed.",
      { fix: { summary: "Percent-encode the password in the URL." } },
    );
  }
  const user = decodeURIComponent(parsed.username);
  const pooled = detectPooler({ url }).pooled;
  const accepted = user === role || (pooled && user.startsWith(`${role}.`));
  if (!accepted) {
    throw new OkmError("OKM1912", `The URL user does not match role ${role}.`, {
      fix: { summary: "Use the role name, or name.suffix on a pooler." },
    });
  }
  return { password: decodeURIComponent(parsed.password), host: parsed.hostname };
}

function replacePassword(url: string, password: string): string {
  const parsed = new URL(url);
  parsed.password = password;
  return parsed.toString();
}

function weak(password: string): boolean {
  if (password.length < 16) return true;
  const half = password.length / 2;
  return Number.isInteger(half) && password.slice(0, half) === password.slice(half);
}

function generatedPassword(): string {
  return randomBytes(32).toString("base64url");
}

function writeIgnored(file: string, body: string, cwd: string): void {
  const check = spawnSync("git", ["check-ignore", "-q", "--", file], { cwd });
  if (check.status !== 0) {
    throw new OkmError("OKM1912", `${file} is not git-ignored.`, {
      fix: { summary: "Add the path to .gitignore before writing a password file." },
    });
  }
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function adminUrl(name: string): string {
  if (name.includes("://") || name.includes("@") || name.includes("/")) {
    throw new OkmError("OKM1912", "--admin-env takes a variable name, not a URL.", {
      fix: { summary: "Pass --admin-env NAME." },
    });
  }
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new OkmError("OKM1912", `--admin-env ${name} is unset.`, {
      fix: { summary: `Set ${name} to the admin URL.` },
    });
  }
  return value;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new OkmError("OKM1912", `${name} is unset.`, {
      fix: { summary: `Set ${name} to the role URL.` },
    });
  }
  return value;
}

function requireRoles(config: MigrateConfig): readonly NormalizedRole[] {
  if (config.roles === undefined) {
    throw new OkmError(
      "OKM1910",
      'roles is not configured.\n  roles: { migration: { name: "okm_migrate", env: "MIGRATE_DATABASE_URL" }, app: { name: "okm_app", env: "APP_DATABASE_URL" } }\nThen run okm roles apply --admin-env <NAME>.',
      { fix: { summary: "Add roles to okmodel.config.ts." } },
    );
  }
  return normalizeRoles(config.roles);
}

async function roleExists(pool: DriverPool, name: string): Promise<boolean> {
  const result = await pool.execute("select 1 from pg_roles where rolname = $1", [name]);
  return result.rows.length > 0;
}

async function serverVersion(pool: DriverPool): Promise<number> {
  const result = await pool.execute("select current_setting('server_version_num')");
  return Number(result.rows[0]?.[0] ?? 0);
}

async function membershipNames(pool: DriverPool, name: string): Promise<string[]> {
  const result = await pool.execute(
    `select r.rolname from pg_auth_members m
     join pg_roles r on r.oid = m.roleid
     join pg_roles u on u.oid = m.member
     where u.rolname = $1 order by r.rolname`,
    [name],
  );
  return result.rows.map((row) => String(row[0] ?? ""));
}

async function acting(pool: DriverPool): Promise<{
  readonly name: string;
  readonly superuser: boolean;
  readonly createRole: boolean;
}> {
  const result = await pool.execute(
    "select current_user, rolsuper, rolcreaterole from pg_roles where rolname = current_user",
  );
  const row = result.rows[0] ?? [];
  return { name: String(row[0] ?? ""), superuser: truth(row[1]), createRole: truth(row[2]) };
}

function truth(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function readCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}
