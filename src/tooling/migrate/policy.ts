/**
 * Target names, the aliasing guard, pooler refusal, and the protection policy.
 *
 * One function, {@link assertTargetPolicy}, is what every entry point calls.
 * Protection is a property of the target. It is not read from `NODE_ENV`.
 */

import { OkmError } from "../../contracts/error.js";
import type { MigrateConfig, TargetInput } from "./config.js";

/** An operation the policy table allows or blocks. */
export type PolicyOperation =
  | "plan"
  | "status"
  | "check"
  | "drift"
  | "verify"
  | "pull"
  | "catalog-export"
  | "inspect"
  | "expand"
  | "reference"
  | "provision"
  | "contract"
  | "unclassified"
  | "push"
  | "backfill"
  | "seed"
  | "history-repair"
  | "drop"
  | "rollback";

/** Flags shared by commands that touch a target. */
export type InvokeFlags = {
  readonly target?: string;
  readonly allowProtected: boolean;
  readonly allowPooler: boolean;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
};

/** A resolved migration target. The plan stores the name, not the URL. */
export type TargetRecord = {
  readonly name: string;
  readonly url: string;
  readonly protected: boolean;
  readonly host: string;
  readonly port: string;
  readonly database: string;
};

const READ: ReadonlySet<PolicyOperation> = new Set([
  "plan",
  "status",
  "check",
  "drift",
  "verify",
  "pull",
  "catalog-export",
  "inspect",
]);

const ALLOWED: ReadonlySet<PolicyOperation> = new Set(["expand", "reference", "provision"]);

const FORWARD_ONLY: ReadonlySet<PolicyOperation> = new Set(["drop", "rollback"]);

/**
 * Refuses an operation the target's protection does not allow.
 *
 * `--allow-protected` is per invocation. It does not lift `drop` or `rollback`.
 * `provision` is allowed here; the caller still refuses a target that is not empty.
 *
 * @param target - Name and protection flag
 * @param operation - What the entry point is about to do
 * @param allowProtected - The invocation passed `--allow-protected`
 */
export function assertTargetPolicy(
  target: { readonly name: string; readonly protected: boolean },
  operation: PolicyOperation,
  allowProtected = false,
): void {
  if (FORWARD_ONLY.has(operation)) {
    throw new OkmError("invalid", "There is no down migration.", {
      fix: { summary: "Recovery is a new forward migration." },
    });
  }
  if (!target.protected || allowProtected) return;
  if (READ.has(operation) || ALLOWED.has(operation)) return;
  throw new OkmError("OKM1850", `${operation} is blocked on protected target ${target.name}.`, {
    kind: "forbidden",
    fix: {
      summary:
        "Run a read-only command or an expand migration, or pass --allow-protected for this invocation.",
    },
  });
}

/**
 * Fails when targets on one host, port, and database disagree about protection.
 *
 * Two unprotected targets may share a database. The comparison ignores schema.
 *
 * @param targets - Resolved targets
 */
export function assertTargetAlias(targets: readonly TargetRecord[]): void {
  const groups = new Map<string, TargetRecord[]>();
  for (const target of targets) {
    const key = `${target.host}\n${target.port}\n${target.database}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [target]);
    else group.push(target);
  }
  for (const group of groups.values()) {
    const protectedTarget = group.find((target) => target.protected);
    const open = group.find((target) => !target.protected);
    if (protectedTarget !== undefined && open !== undefined) {
      throw new OkmError(
        "OKM1852",
        `${open.name} and ${protectedTarget.name} resolve to the same database and disagree about protection.`,
        {
          fix: {
            summary:
              "Give those targets the same protection flag. okm check and okm doctor both report this.",
          },
        },
      );
    }
  }
}

/**
 * Refuses a known pooler URL.
 *
 * Apply needs one session for the advisory lock. A transaction-mode pooler
 * does not keep that session. `--allow-pooler` is the override.
 *
 * @param url - Target URL
 * @param allowPooler - The invocation opted in
 */
export function assertDirectConnection(url: string, allowPooler: boolean): void {
  if (allowPooler) return;
  const endpoint = endpointOf(url);
  const parsed = new URL(url);
  const host = endpoint.host;
  if (
    host.includes("pooler") ||
    host.includes("pgbouncer") ||
    host.includes("-pooler") ||
    endpoint.port === "6543" ||
    parsed.searchParams.get("pgbouncer") === "true"
  ) {
    throw new OkmError(
      "invalid",
      `Refusing pooler host ${host}. Apply needs a direct connection.`,
      { fix: { summary: "Use a direct connection, or pass --allow-pooler." } },
    );
  }
}

/**
 * Lists configured targets.
 *
 * `database` is the target named `default`. `targets` replaces it. Setting
 * both is refused.
 *
 * @param config - Project config
 * @returns Targets in name order
 */
export function listTargets(config: MigrateConfig): readonly TargetRecord[] {
  if (config.database !== undefined && config.targets !== undefined) {
    throw new OkmError("invalid", "Set database or targets, not both.", {
      fix: { summary: "database is the one target named default. Use targets for more than one." },
    });
  }
  const entries: [string, TargetInput][] = [];
  if (config.database !== undefined) entries.push(["default", config.database]);
  if (config.targets !== undefined) {
    for (const name of Object.keys(config.targets).sort()) {
      const input = config.targets[name];
      if (input !== undefined) entries.push([name, input]);
    }
  }
  return entries.map(([name, input]) => resolveTarget(name, input));
}

/**
 * Picks the target a command that must not guess will use.
 *
 * One configured target is that target. Several require `name` (OKM1853).
 *
 * @param config - Project config
 * @param name - `--target`, when the command passed one
 * @returns The target
 */
export function selectTarget(config: MigrateConfig, name: string | undefined): TargetRecord {
  const targets = listTargets(config);
  if (targets.length === 0) {
    throw new OkmError("OKM1845", "No target is configured.", {
      fix: { summary: "Set database or targets in okmodel.config.ts." },
    });
  }
  if (name === undefined) {
    if (targets.length === 1) {
      const only = targets[0];
      if (only !== undefined) return only;
    }
    throw new OkmError("OKM1853", "Several targets are configured and --target was not passed.", {
      fix: { summary: "Pass --target <name>. The command does not guess." },
    });
  }
  const found = targets.find((target) => target.name === name);
  if (found === undefined) {
    throw new OkmError("OKM1845", `Target ${name} is not configured.`, {
      fix: { summary: "Pass a name from targets, or database for the target named default." },
    });
  }
  return found;
}

function resolveTarget(name: string, input: TargetInput): TargetRecord {
  const url = typeof input === "string" ? input : input.url;
  const protectedTarget = typeof input === "string" ? false : input.protected === true;
  if (url === undefined || url.length === 0) {
    throw new OkmError("OKM1845", `Target ${name} has no url.`, {
      fix: { summary: "Set the target url. A target is not inferred from the environment." },
    });
  }
  const endpoint = endpointOf(url);
  return {
    name,
    url,
    protected: protectedTarget,
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
  };
}

function endpointOf(url: string): { host: string; port: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OkmError("OKM1845", "The target URL is not a Postgres URL.", {
      fix: { summary: "Pass a postgres:// URL for the target." },
    });
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port.length > 0 ? parsed.port : "5432",
    database,
  };
}
