/**
 * `okm doctor --production`: a read-only misuse check of one target (X4, D315).
 *
 * Each finding has a stable id, a severity (`fail`, `warn`, `ok`), and a
 * one-line fix. Every query runs in one `READ ONLY` transaction on one fresh
 * session. Nothing here prints the URL, host, user, or password: a finding
 * names the target by its configured name.
 *
 * The check cannot see `connect()` options such as `requireMeta`. It reports
 * what the database and the config show.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import type { DriverConnection, ExecuteResult } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { POSTGRES_FLOOR, POSTGRES_MAJORS } from "../../dialects/pg/floor.js";
import { assertRoleHealth } from "../../dialects/pg/role/check.js";
import { tagOutcome } from "../cli/outcome.js";
import { DEFAULT_LOCK_MS, DEFAULT_STATEMENT_MS } from "./apply.js";
import { driverUrl } from "./driver-url.js";
import { catalogNamespace } from "./export.js";
import {
  assertExtensionsAgainstPool,
  assertMajorAgainstPool,
  encodeTextArray,
  installedExtensionVersions,
  serverMajor,
  type RequirementsSchema,
  type StatementRunner,
} from "./server-requirements.js";
import { finishQuiet } from "./lost.js";
import { omitManagedObjects } from "./managed.js";
import {
  assertTargetPolicy,
  poolerSignal,
  selectTarget,
  type InvokeFlags,
  type PoolerSignal,
  type TargetRecord,
} from "./policy.js";
import type { MigrateConfig } from "./config.js";
import { projectPath, type ProjectContext } from "./paths.js";
import { openProject } from "./project.js";
import { describe } from "./schema-api.js";

/** How serious a finding is. Any `fail` makes the command exit non-zero. */
export type ProductionSeverity = "fail" | "warn" | "ok";

/** One line of the report. `id` is stable across releases. */
export type ProductionFinding = {
  /** Stable name, for example `target-protection`. */
  readonly id: string;
  readonly severity: ProductionSeverity;
  /** Registry code, when this finding has one. */
  readonly code?: string;
  /** What was found. Never the URL, host, user, or password. */
  readonly summary: string;
  /** One line. `No action needed.` for `ok`. */
  readonly fix: string;
};

/** The whole report. */
export type ProductionReport = {
  /** Configured target name. */
  readonly target: string;
  readonly summary: { readonly fail: number; readonly warn: number; readonly ok: number };
  readonly findings: readonly ProductionFinding[];
};

/** What the config and the invocation say about the target. */
export type ProductionInput = {
  readonly target: Pick<TargetRecord, "name" | "protection" | "url">;
  readonly config: MigrateConfig;
  /** `--allow-pooler` was passed, or the config sets `allowPooler`. */
  readonly allowPooler: boolean;
};

/** Settings read from the database in one read-only transaction. */
export type ProductionFacts = {
  readonly metaPresent: boolean;
  readonly role: { readonly superuser: boolean; readonly bypassRls: boolean } | undefined;
  readonly ownedTables: number;
  readonly sessionLockMs: number | undefined;
  readonly sessionStatementMs: number | undefined;
  readonly serverMajor: number;
  readonly minimum: Refusal | undefined;
  readonly roleConfig: Refusal | undefined | "not-set";
  readonly extensions: ExtensionFacts;
};

/** Required extensions and what the server has. */
export type ExtensionFacts = {
  readonly required: readonly string[];
  readonly versions: ReadonlyMap<string, string>;
  readonly refusal: Refusal | undefined;
};

/** An error an existing check raised, with the URL parts removed from its text. */
export type Refusal = {
  readonly code: string;
  readonly message: string;
  readonly fix: string;
};

/** Code for a target that is not protected in config. */
export const UNPROTECTED_CODE = "OKM2202";
/** Code for a pooler-looking target. */
export const POOLER_CODE = "OKM2203";
/** Code for a zero `lock_timeout` or `statement_timeout`. */
export const TIMEOUT_CODE = "OKM2201";
/** Code for a run with at least one `fail` finding. */
export const PRODUCTION_FAILED_CODE = "OKM2204";

const OK_FIX = "No action needed.";

/** Width of an `OKM####` code, so the summary column lines up. */
const CODE_WIDTH = 7;

/**
 * Finding for the target's `protected` flag.
 *
 * Only config `protected: true` passes. A local store fingerprint protects one
 * machine, not the project, and the target's name is never read.
 *
 * @param target - Name and where protection came from
 * @returns The finding
 */
export function protectionFinding(
  target: Pick<TargetRecord, "name" | "protection">,
): ProductionFinding {
  const id = "target-protection";
  if (target.protection === "project" || target.protection === "project-and-store") {
    return { id, severity: "ok", summary: "The target sets protected: true.", fix: OK_FIX };
  }
  const how =
    target.protection === "store"
      ? "The target is protected only by a fingerprint in this machine's store, not by protected: true in the config."
      : "The target does not set protected: true.";
  return {
    id,
    severity: "fail",
    code: UNPROTECTED_CODE,
    summary: how,
    fix: "Set protected: true on the production target in okmodel.config.ts.",
  };
}

/**
 * Finding for the pooler patterns `okm migrate apply` refuses.
 *
 * @param url - Target URL. It is read, never printed
 * @param allowPooler - `--allow-pooler` was passed, or `allowPooler` is set in the config
 * @returns The finding
 */
export function poolerFinding(url: string, allowPooler: boolean): ProductionFinding {
  const id = "pooler";
  let signal: PoolerSignal | undefined;
  try {
    signal = poolerSignal(url);
  } catch {
    signal = undefined;
  }
  if (signal === undefined) {
    return {
      id,
      severity: "ok",
      summary: "The target URL does not look like a pooler.",
      fix: OK_FIX,
    };
  }
  const part =
    signal === "host"
      ? "the host name"
      : signal === "port"
        ? "the port (6543 or 6432)"
        : "the pgbouncer=true parameter";
  if (allowPooler) {
    return {
      id,
      severity: "fail",
      code: POOLER_CODE,
      summary: `The target URL looks like a pooler (${part}) and pooler use is allowed for this run.`,
      fix: "Use a direct connection for apply, and drop --allow-pooler and allowPooler.",
    };
  }
  return {
    id,
    severity: "warn",
    code: POOLER_CODE,
    summary: `The target URL looks like a pooler (${part}). okm migrate apply refuses it.`,
    fix: "Point the target at a direct connection.",
  };
}

/**
 * Finding for the `okm_meta` table.
 *
 * `connect({ requireMeta })` is an application option the check cannot see.
 *
 * @param present - Whether `okm_meta` exists in the catalog schema
 * @returns The finding
 */
export function metaFinding(present: boolean): ProductionFinding {
  const id = "okm-meta";
  if (present) {
    return {
      id,
      severity: "ok",
      summary:
        "okm_meta exists. The check cannot see connect() options: confirm the app passes requireMeta: true.",
      fix: OK_FIX,
    };
  }
  return {
    id,
    severity: "fail",
    code: "OKM1520",
    summary:
      "okm_meta does not exist on the target, so connect({ requireMeta: true }) would refuse it. The check cannot see connect() options.",
    fix: "Run okm migrate apply against the target, then pass requireMeta: true in the app.",
  };
}

/**
 * Finding for superuser and `BYPASSRLS` on the login role.
 *
 * @param role - Attributes of the role the URL logs in as, when it is visible
 * @returns The finding
 */
export function roleFinding(role: ProductionFacts["role"]): ProductionFinding {
  const id = "role-privilege";
  if (role === undefined) {
    return {
      id,
      severity: "fail",
      code: "OKM1707",
      summary: "The login role is not visible in pg_roles.",
      fix: "Connect as a role that pg_roles lists.",
    };
  }
  if (role.superuser || role.bypassRls) {
    const which = role.superuser ? "a superuser" : "BYPASSRLS";
    return {
      id,
      severity: "fail",
      code: "OKM1707",
      summary: `The login role is ${which}, so row-level security and grants do not bind it.`,
      fix: "Log in as a role that is neither a superuser nor BYPASSRLS (docs/roles.md).",
    };
  }
  return {
    id,
    severity: "ok",
    summary: "The login role is not a superuser and does not have BYPASSRLS.",
    fix: OK_FIX,
  };
}

/**
 * Finding for a login role that owns the schema's tables.
 *
 * The check cannot tell the migrator from the app role by the URL alone.
 *
 * @param owned - Catalog tables the role owns, or inherits ownership of
 * @param superuser - The role is a superuser (reported by `role-privilege`)
 * @returns The finding
 */
export function ownerFinding(owned: number, superuser: boolean): ProductionFinding {
  const id = "role-owns-tables";
  if (owned === 0 || superuser) {
    return {
      id,
      severity: "ok",
      summary: superuser
        ? "Not evaluated for a superuser. See role-privilege."
        : "The login role owns none of the schema's tables.",
      fix: OK_FIX,
    };
  }
  return {
    id,
    severity: "warn",
    code: "OKM1707",
    summary: `The login role owns ${String(owned)} of the schema's tables. That is fine for the migrator and wrong for the app role: an owner is not bound by row-level security.`,
    fix: "Run the app as a role that does not own the tables (docs/roles.md).",
  };
}

/**
 * Findings for `lock_timeout` and `statement_timeout`.
 *
 * `okm migrate apply` sets its own `lock_timeout` on its session (5000 ms, or
 * `timeouts.lock`), so that value is the one reported for migrations and the
 * role's session value is named beside it. `statement_timeout` is reported
 * from the role's fresh session, with the apply value named beside it. A flag
 * on one apply invocation overrides either apply value. Zero disables the limit.
 *
 * @param config - Project config
 * @param sessionLockMs - `lock_timeout` in a fresh session, in ms
 * @param sessionStatementMs - `statement_timeout` in a fresh session, in ms
 * @returns Two findings
 */
export function timeoutFindings(
  config: MigrateConfig,
  sessionLockMs: number | undefined,
  sessionStatementMs: number | undefined,
): readonly ProductionFinding[] {
  const applyLock = config.timeouts?.lock ?? DEFAULT_LOCK_MS;
  const applyStatement = config.timeouts?.statement ?? DEFAULT_STATEMENT_MS;
  const lockSource = config.timeouts?.lock === undefined ? "default" : "timeouts.lock";
  const statementSource =
    config.timeouts?.statement === undefined ? "default" : "timeouts.statement";
  const lock: ProductionFinding =
    applyLock === 0
      ? {
          id: "lock-timeout",
          severity: "warn",
          code: TIMEOUT_CODE,
          summary: `okm migrate apply sets lock_timeout to 0 (${lockSource}), so a migration waits for a lock without limit. The role's session value is ${formatMs(sessionLockMs)}.`,
          fix: "Set timeouts.lock to a positive number of milliseconds.",
        }
      : {
          id: "lock-timeout",
          severity: "ok",
          summary: `okm migrate apply sets lock_timeout to ${formatMs(applyLock)} (${lockSource}) and that value applies to migrations. The role's session value is ${formatMs(sessionLockMs)} and applies to everything else.`,
          fix: OK_FIX,
        };
  const statement: ProductionFinding =
    sessionStatementMs === 0
      ? {
          id: "statement-timeout",
          severity: "warn",
          code: TIMEOUT_CODE,
          summary: `statement_timeout is 0 for this role in a fresh session, so a statement runs without limit. okm migrate apply sets ${formatMs(applyStatement)} (${statementSource}) for migrations only.`,
          fix: "Run ALTER ROLE <app role> SET statement_timeout = '30s' (or the limit you want).",
        }
      : {
          id: "statement-timeout",
          severity: "ok",
          summary: `statement_timeout is ${formatMs(sessionStatementMs)} for this role in a fresh session. okm migrate apply sets ${formatMs(applyStatement)} (${statementSource}) for migrations.`,
          fix: OK_FIX,
        };
  return [lock, statement];
}

/**
 * Finding for the server major.
 *
 * @param major - Major the server reported
 * @param minimum - The schema floor refusal (OKM1802 or OKM1803), when it applies
 * @returns The finding
 */
export function serverFinding(major: number, minimum: Refusal | undefined): ProductionFinding {
  const id = "server-version";
  const newest = POSTGRES_MAJORS[POSTGRES_MAJORS.length - 1] ?? POSTGRES_FLOOR;
  const window = `${String(POSTGRES_FLOOR)}-${String(newest)}`;
  if (minimum !== undefined) {
    return {
      id,
      severity: "fail",
      code: minimum.code,
      summary: `${minimum.message} Supported majors are ${window}.`,
      fix: minimum.fix,
    };
  }
  if (major < POSTGRES_FLOOR) {
    return {
      id,
      severity: "fail",
      code: "OKM1803",
      summary: `The server is PostgreSQL ${String(major)}, below the supported window ${window}.`,
      fix: `Upgrade to PostgreSQL ${String(POSTGRES_FLOOR)} or higher.`,
    };
  }
  if (major > newest) {
    return {
      id,
      severity: "warn",
      summary: `The server is PostgreSQL ${String(major)}, newer than the supported window ${window}.`,
      fix: `Run the supported majors (${window}) until a release lists ${String(major)}.`,
    };
  }
  return {
    id,
    severity: "ok",
    summary: `The server is PostgreSQL ${String(major)}, inside the supported window ${window}.`,
    fix: OK_FIX,
  };
}

/**
 * Finding for required extensions.
 *
 * @param facts - Required names, installed versions, and the refusal, if any
 * @returns The finding
 */
export function extensionFinding(facts: ExtensionFacts): ProductionFinding {
  const id = "extensions";
  if (facts.refusal !== undefined) {
    return {
      id,
      severity: "fail",
      code: facts.refusal.code,
      summary: facts.refusal.message,
      fix: facts.refusal.fix,
    };
  }
  if (facts.required.length === 0) {
    return { id, severity: "ok", summary: "The schema requires no extension.", fix: OK_FIX };
  }
  const listed = facts.required
    .map((name) => {
      const version = facts.versions.get(name);
      return version === undefined ? `${name} (a migration creates it)` : `${name} ${version}`;
    })
    .join(", ");
  return {
    id,
    severity: "ok",
    summary: `Required extensions: ${listed}.`,
    fix: OK_FIX,
  };
}

/**
 * Finding for `defineConfig({ roles })`, reusing the role health check.
 *
 * @param refusal - The error `assertRoleHealth` threw, or `undefined` when it passed
 * @returns The finding
 */
export function roleConfigFinding(refusal: Refusal | undefined): ProductionFinding {
  const id = "role-config";
  if (refusal === undefined) {
    return {
      id,
      severity: "ok",
      summary:
        "The roles named in the config exist and the app role can reach each managed object.",
      fix: OK_FIX,
    };
  }
  return {
    id,
    severity: "fail",
    ...(/^OKM\d{4}$/.test(refusal.code) ? { code: refusal.code } : {}),
    summary: refusal.message,
    fix: refusal.fix,
  };
}

/**
 * Builds the report from the input and the facts.
 *
 * @param input - Target, config, and whether pooler use is allowed
 * @param facts - What the database said
 * @returns Findings in a fixed order, and their counts
 */
export function buildReport(input: ProductionInput, facts: ProductionFacts): ProductionReport {
  const findings: ProductionFinding[] = [
    protectionFinding(input.target),
    poolerFinding(input.target.url, input.allowPooler),
    metaFinding(facts.metaPresent),
    roleFinding(facts.role),
    ownerFinding(facts.ownedTables, facts.role?.superuser === true),
  ];
  if (facts.roleConfig !== "not-set") {
    findings.push(roleConfigFinding(facts.roleConfig));
  }
  findings.push(
    ...timeoutFindings(input.config, facts.sessionLockMs, facts.sessionStatementMs),
    serverFinding(facts.serverMajor, facts.minimum),
    extensionFinding(facts.extensions),
  );
  return { target: input.target.name, summary: countOf(findings), findings };
}

/**
 * Prints the report as a table.
 *
 * @param report - The report
 * @returns Text for stdout, including the trailing newline
 */
export function formatReport(report: ProductionReport): string {
  const width = Math.max(...report.findings.map((item) => item.id.length));
  const lines = [`target \`${report.target}\``];
  for (const item of report.findings) {
    const code = (item.code ?? "").padEnd(CODE_WIDTH);
    lines.push(`${item.severity.padEnd(4)}  ${item.id.padEnd(width)}  ${code}  ${item.summary}`);
    if (item.severity !== "ok")
      lines.push(`${" ".repeat(width + CODE_WIDTH + 10)}fix: ${item.fix}`);
  }
  const { fail, warn, ok } = report.summary;
  lines.push(`${String(fail)} fail, ${String(warn)} warn, ${String(ok)} ok`);
  return `${lines.join("\n")}\n`;
}

/**
 * Removes the URL parts from text that came from another check.
 *
 * Findings built here never contain them. A message from `assertRoleHealth`
 * can name the login role, so that text passes through this.
 *
 * @param text - Text about to be printed
 * @param url - Target URL
 * @returns The text with the URL, host, user, and password replaced
 */
export function scrub(text: string, url: string): string {
  let out = text;
  const secrets: string[] = [url];
  try {
    const parsed = new URL(url);
    secrets.push(
      parsed.hostname,
      decodeURIComponent(parsed.username),
      decodeURIComponent(parsed.password),
    );
  } catch {
    // An unparsable URL is already refused when the target is listed.
  }
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    const escaped = secret.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replaceAll(
      new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "g"),
      "[redacted]",
    );
  }
  return out;
}

/**
 * Loads the project, selects the one target, and runs the check.
 *
 * Several targets and no `--target` is OKM1853 (a usage error), not a skip.
 *
 * @param project - Project directory or context
 * @param flags - `--target`, `--allow-protected`, and `--allow-pooler`
 * @returns The report
 */
export async function doctorProduction(
  project: string | ProjectContext,
  flags: InvokeFlags,
): Promise<ProductionReport> {
  const opened = await openProject(project);
  const target = selectTarget(opened.config, flags.target);
  assertTargetPolicy(target, "check", flags.allowProtected);
  return productionReport(opened, {
    target,
    config: opened.config,
    allowPooler: flags.allowPooler || opened.config.allowPooler === true,
  });
}

/**
 * Runs the check against one target.
 *
 * `--target` rules are the caller's: this takes the one selected target. A
 * connection or query failure is reported as an unavailable target without
 * the driver's text, which can name the host or the user.
 *
 * @param opened - Loaded project
 * @param input - Target, config, and whether pooler use is allowed
 * @param dependencies - Test seam: wraps the connection the queries run on
 * @returns The report
 * @throws OkmError `unavailable` when the target cannot be read
 */
export async function productionReport(
  opened: { readonly cwd: string; readonly built: ProductionBuilt },
  input: ProductionInput,
  dependencies?: { readonly wrap?: (connection: DriverConnection) => DriverConnection },
): Promise<ProductionReport> {
  const pool = open({ url: driverUrl(input.target.url), max: 1 });
  try {
    const raw = await pool.reserve?.();
    if (raw === undefined) throw new Error("The target connection cannot start a transaction.");
    const connection = dependencies?.wrap?.(raw) ?? raw;
    try {
      const facts = await readOnly(connection, (runner) => readFacts(runner, opened, input));
      return buildReport(input, facts);
    } finally {
      await finishQuiet(() => raw.release());
    }
  } catch (error) {
    throw unreadable(error, input.target);
  } finally {
    await finishQuiet(() => pool.close());
  }
}

/** The part of a loaded schema this check reads. */
export type ProductionBuilt = RequirementsSchema;

/**
 * Runs `run` in one `READ ONLY` transaction on a connection.
 *
 * @param connection - A fresh connection
 * @param run - Reads. A write fails with SQLSTATE 25006
 * @returns What `run` returned
 */
export async function readOnly<T>(
  connection: StatementRunner,
  run: (runner: StatementRunner) => Promise<T>,
): Promise<T> {
  await connection.execute("begin read only");
  try {
    const value = await run(connection);
    await connection.execute("commit");
    return value;
  } catch (error) {
    await finishQuiet(() => connection.execute("rollback"));
    throw error;
  }
}

async function readFacts(
  runner: StatementRunner,
  opened: { readonly cwd: string; readonly built: ProductionBuilt },
  input: ProductionInput,
): Promise<ProductionFacts> {
  const schema = catalogNamespace(input.config);
  const meta = await runner.execute(
    "select (to_regclass(format('%I.okm_meta', $1::text)) is not null)::text",
    [schema],
  );
  const role = await runner.execute(
    "select rolsuper::text, rolbypassrls::text from pg_roles where rolname = session_user",
  );
  const tables = catalogTables(opened.built);
  const owned =
    tables.length === 0
      ? 0
      : Number(
          cellText(
            (
              await runner.execute(
                `select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = $1 and c.relkind in ('r', 'p') and c.relname = any($2::text[])
                   and pg_has_role(session_user, c.relowner, 'USAGE')`,
                [schema, encodeTextArray(tables)],
              )
            ).rows[0]?.[0],
          ) || "0",
        );
  const settings = await runner.execute(
    "select name, setting from pg_settings where name in ('lock_timeout', 'statement_timeout')",
  );
  const major = await serverMajor(runner);
  const roleRow = role.rows[0];
  return {
    metaPresent: cellText(meta.rows[0]?.[0]) === "true",
    role:
      roleRow === undefined
        ? undefined
        : {
            superuser: cellText(roleRow[0]) === "true",
            bypassRls: cellText(roleRow[1]) === "true",
          },
    ownedTables: owned,
    sessionLockMs: milliseconds(settings.rows, "lock_timeout"),
    sessionStatementMs: milliseconds(settings.rows, "statement_timeout"),
    serverMajor: major,
    minimum: await refusal(() => assertMajorAgainstPool(runner, opened.built), input.target.url),
    roleConfig: await roleConfigOf(runner, opened, input),
    extensions: await extensionFacts(runner, opened, input),
  };
}

async function roleConfigOf(
  runner: StatementRunner,
  opened: { readonly built: ProductionBuilt },
  input: ProductionInput,
): Promise<Refusal | undefined | "not-set"> {
  const roles = input.config.roles;
  if (roles === undefined) return "not-set";
  const objects = omitManagedObjects(opened.built.catalog).objects;
  return refusal(() => assertRoleHealth(runner, roles, objects), input.target.url);
}

async function extensionFacts(
  runner: StatementRunner,
  opened: { readonly cwd: string; readonly built: ProductionBuilt },
  input: ProductionInput,
): Promise<ExtensionFacts> {
  const required = describe(opened.built).requirements.extensions.map((item) => item.name);
  if (required.length === 0) return { required, versions: new Map(), refusal: undefined };
  const directory = projectPath(opened.cwd, input.config.migrations ?? "migrations");
  return {
    required,
    versions: await installedExtensionVersions(runner, required),
    refusal: await refusal(
      () => assertExtensionsAgainstPool(runner, opened.built, directory),
      input.target.url,
    ),
  };
}

async function refusal(run: () => Promise<void>, url: string): Promise<Refusal | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (!(error instanceof OkmError) || error.kind === "unavailable") throw error;
    return {
      code: error.code,
      message: scrub(error.message, url),
      fix: scrub(error.fix.summary, url),
    };
  }
}

function catalogTables(built: ProductionBuilt): readonly string[] {
  const names: string[] = [];
  for (const object of omitManagedObjects(built.catalog).objects) {
    if (object.kind === "table" && object.owner !== "external") names.push(object.identity.name);
  }
  return names;
}

function milliseconds(rows: ExecuteResult["rows"], name: string): number | undefined {
  for (const row of rows) {
    if (row[0] === name) {
      const value = Number(row[1]);
      return Number.isFinite(value) ? value : undefined;
    }
  }
  return undefined;
}

function cellText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return "unknown";
  return value === 0 ? "0 (no limit)" : `${String(value)} ms`;
}

function countOf(findings: readonly ProductionFinding[]): ProductionReport["summary"] {
  let fail = 0;
  let warn = 0;
  let ok = 0;
  for (const item of findings) {
    if (item.severity === "fail") fail += 1;
    else if (item.severity === "warn") warn += 1;
    else ok += 1;
  }
  return { fail, warn, ok };
}

const DRIVER_HINT =
  /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|28P01|28000|3D000|57P03)\b/;

function unreadable(error: unknown, target: Pick<TargetRecord, "name">): OkmError {
  if (error instanceof OkmError && /^OKM\d{4}$/.test(error.code)) return error;
  const text = error instanceof Error ? error.message : "";
  const hint = DRIVER_HINT.exec(text)?.[1];
  return tagOutcome(
    new OkmError(
      "unavailable",
      `Could not read target \`${target.name}\`${hint === undefined ? "" : ` (${hint})`}.`,
      {
        kind: "unavailable",
        fix: {
          summary:
            "Check the target url and that the server is reachable. okm doctor --production prints no host, user, or password.",
        },
      },
    ),
    "unreachable",
  );
}
