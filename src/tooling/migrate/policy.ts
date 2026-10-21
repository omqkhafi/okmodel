/**
 * Target names, the aliasing guard, pooler refusal, and the protection policy.
 *
 * One function, {@link assertTargetPolicy}, is what every entry point calls.
 * Protection is a property of the target. It is not read from `NODE_ENV`.
 */

import { OkmError } from "../../contracts/error.js";
import { tagOutcome } from "../cli/outcome.js";
import type { MigrateConfig, TargetInput } from "./config.js";
import { hostDbFingerprint, postgresEndpoint } from "./fingerprint.js";
import { protectedStorePath, readProtectedStore } from "./protected-store.js";

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

/**
 * Where a target's protection came from.
 *
 * `open` is neither. `project` is config `protected: true` only. `store` is
 * a user fingerprint only. `project-and-store` is both. Callers that pass
 * only `protected: true` are treated as `project`, so `--allow-protected`
 * still lifts that case.
 */
export type ProtectionMatch = "open" | "project" | "store" | "project-and-store";

/** A resolved migration target. The plan stores the name, not the URL. */
export type TargetRecord = {
  readonly name: string;
  readonly url: string;
  readonly protected: boolean;
  readonly protection: ProtectionMatch;
  readonly host: string;
  readonly port: string;
  readonly database: string;
};

/** Where {@link listTargets} reads fingerprints. The default is the user store. */
export type StoreOptions = {
  readonly storePath?: string;
};

/** A target {@link assertTargetPolicy} can see. `protection` omitted means project config. */
export type PolicySubject = {
  readonly name: string;
  readonly protected: boolean;
  readonly protection?: ProtectionMatch;
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

const STORE_FIX =
  "Open a terminal for this invocation. A terminal is friction, not proof of a human.";

/**
 * True when the operation changes a database and protection can refuse it.
 *
 * Read, expand, reference, and provision are not. `drop` and `rollback`
 * are refused by a different error and are not commands.
 *
 * @param operation - Policy operation
 * @returns Whether a store fingerprint can refuse it without a terminal
 */
export function isStateChangingOperation(operation: PolicyOperation): boolean {
  return !READ.has(operation) && !ALLOWED.has(operation) && !FORWARD_ONLY.has(operation);
}

/**
 * Refuses a store fingerprint when this process has no terminal.
 *
 * `--allow-protected` does not lift it. Project-config protection does not
 * enter this function's refusal. A terminal is friction, not proof of a human.
 *
 * @param target - Name, flag, and where the flag came from
 * @param operation - What the entry point is about to do
 * @param tty - Whether stdin is a terminal. The default is this process
 */
export function assertStoreTerminal(
  target: PolicySubject,
  operation: PolicyOperation,
  tty: boolean = process.stdin.isTTY === true,
): void {
  const match = protectionOf(target);
  if (match !== "store" && match !== "project-and-store") return;
  if (!isStateChangingOperation(operation)) return;
  if (tty) return;
  throw new OkmError(
    "OKM1859",
    `${operation} is blocked on protected target ${target.name} (${reasonText(match)}). A store fingerprint blocks this state-changing command when there is no terminal.`,
    { kind: "forbidden", fix: { summary: STORE_FIX } },
  );
}

/**
 * Refuses `okm driver test --url` when that URL's fingerprint is stored
 * and there is no terminal.
 *
 * A terminal follows today's policy for a URL the command does not mark
 * protected in config: the store check is the only refusal here.
 *
 * @param url - `--url`
 * @param options - Store path and terminal flag for tests
 */
export function guardStoredDriverUrl(
  url: string,
  options?: { readonly storePath?: string; readonly tty?: boolean },
): void {
  const endpoint = postgresEndpoint(url);
  const hostDb = hostDbFingerprint(endpoint.host, endpoint.port, endpoint.database);
  const store = readProtectedStore(options?.storePath ?? protectedStorePath());
  if (!store.fingerprints.includes(hostDb)) return;
  assertStoreTerminal(
    { name: "url", protected: true, protection: "store" },
    "seed",
    options?.tty ?? process.stdin.isTTY === true,
  );
}

/**
 * Sentence for a protection match. `open` is not a refusal reason.
 *
 * @param target - Name, flag, and where the flag came from
 * @returns `project config`, `store fingerprint`, or both
 */
export function protectionReason(target: PolicySubject): string {
  return reasonText(protectionOf(target));
}

/**
 * Builds the subject runner and apply pass into {@link assertTargetPolicy}.
 *
 * @param input - Name, flag, and optional match
 * @returns The subject, omitting an unknown match so it stays project config
 */
export function policySubject(input: PolicySubject): PolicySubject {
  if (input.protection === undefined) return { name: input.name, protected: input.protected };
  return { name: input.name, protected: input.protected, protection: input.protection };
}

/**
 * Refuses an operation the target's protection does not allow.
 *
 * `--allow-protected` is per invocation. It does not lift `drop` or `rollback`,
 * and it does not lift a store fingerprint when there is no terminal.
 * `provision` is allowed here; the caller still refuses a target that is not empty.
 *
 * @param target - Name and protection flag
 * @param operation - What the entry point is about to do
 * @param allowProtected - The invocation passed `--allow-protected`
 * @param options - Terminal flag. The default is this process
 */
export function assertTargetPolicy(
  target: PolicySubject,
  operation: PolicyOperation,
  allowProtected = false,
  options?: { readonly tty?: boolean },
): void {
  if (FORWARD_ONLY.has(operation)) {
    throw new OkmError("invalid", "There is no down migration.", {
      fix: { summary: "Recovery is a new forward migration." },
    });
  }
  assertStoreTerminal(target, operation, options?.tty ?? process.stdin.isTTY === true);
  if (!target.protected || allowProtected) return;
  if (READ.has(operation) || ALLOWED.has(operation)) return;
  throw new OkmError(
    "OKM1850",
    `${operation} is blocked on protected target ${target.name} (${protectionReason(target)}).`,
    {
      kind: "forbidden",
      fix: {
        summary: "Use a read-only command or an expand migration.",
      },
    },
  );
}

function protectionOf(target: PolicySubject): ProtectionMatch {
  if (target.protection !== undefined) return target.protection;
  return target.protected ? "project" : "open";
}

function reasonText(match: ProtectionMatch): string {
  if (match === "project") return "project config";
  if (match === "store") return "store fingerprint";
  if (match === "project-and-store") return "project config and store fingerprint";
  return "open";
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
  if (poolerSignal(url) !== undefined) {
    throw tagOutcome(
      new OkmError(
        "invalid",
        `Refusing pooler host ${endpointOf(url).host}. Apply needs a direct connection.`,
        { fix: { summary: "Use a direct connection." } },
      ),
      "unreachable",
    );
  }
}

/** Which part of a target URL looks like a pooler. */
export type PoolerSignal = "host" | "port" | "parameter";

/**
 * Reads the URL patterns {@link assertDirectConnection} refuses.
 *
 * Only the URL is read. No connection is made, and the result names the part,
 * not its value.
 *
 * @param url - Target URL
 * @returns The first matching part, or `undefined` for a direct-looking URL
 */
export function poolerSignal(url: string): PoolerSignal | undefined {
  const endpoint = endpointOf(url);
  const host = endpoint.host;
  if (host.includes("pooler") || host.includes("pgbouncer") || host.includes("-pooler")) {
    return "host";
  }
  if (endpoint.port === "6543" || endpoint.port === "6432") return "port";
  if (new URL(url).searchParams.get("pgbouncer") === "true") return "parameter";
  return undefined;
}

/** Options for {@link assertStableBackend}. */
export type StableBackendOptions = {
  /**
   * Holds another backend between pid reads so a LIFO transaction-mode
   * pooler cannot hand the next read the same server. Resolves to a release
   * function that ends the hold.
   */
  readonly holdBackend?: () => Promise<() => Promise<void>>;
};

/**
 * Refuses a session whose backend pid changes across eight statements.
 *
 * The reads are separate round trips and are not wrapped in a transaction.
 * A transaction-mode pooler can hand back a different backend. Two reads
 * miss a default PgBouncer with `server_round_robin=0` (LIFO); eight reads
 * plus an optional hold between them catch that case. A direct session
 * keeps one pid. `--allow-pooler` skips the probe.
 *
 * @param readPid - Reads `pg_backend_pid()` on the session under test
 * @param allowPooler - The invocation opted in
 * @param options - Optional hold used by the migrate warm-and-hold probe
 */
export async function assertStableBackend(
  readPid: () => Promise<string>,
  allowPooler: boolean,
  options?: StableBackendOptions,
): Promise<void> {
  if (allowPooler) return;
  const seen = new Set<string>();
  let first = "";
  let release: (() => Promise<void>) | undefined;
  try {
    for (let i = 0; i < 8; i += 1) {
      const pid = await readPid();
      if (first.length === 0) first = pid;
      seen.add(pid);
      if (seen.size >= 2) {
        const second = [...seen].find((value) => value !== first) ?? pid;
        throw new OkmError(
          "OKM1854",
          `The backend pid changed from ${first} to ${second}. A pooler is handing out a new session between statements.`,
          { fix: { summary: "Use a direct connection." } },
        );
      }
      if (release !== undefined) {
        await release();
        release = undefined;
      }
      if (i < 7 && options?.holdBackend !== undefined) {
        release = await options.holdBackend();
      }
    }
  } finally {
    if (release !== undefined) await release().catch(() => undefined);
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
export function listTargets(
  config: MigrateConfig,
  options?: StoreOptions,
): readonly TargetRecord[] {
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
  const fingerprints = new Set(
    readProtectedStore(options?.storePath ?? protectedStorePath()).fingerprints,
  );
  return entries.map(([name, input]) => resolveTarget(name, input, fingerprints));
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
export function selectTarget(
  config: MigrateConfig,
  name: string | undefined,
  options?: StoreOptions,
): TargetRecord {
  const targets = listTargets(config, options);
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

function resolveTarget(
  name: string,
  input: TargetInput,
  fingerprints: ReadonlySet<string>,
): TargetRecord {
  if (typeof input !== "string" && isReplicaTarget(input)) {
    throw new OkmError(
      "OKM1845",
      `Target ${name} is a replica. Migrations run on the primary only.`,
      {
        fix: {
          summary:
            "Set database or targets to the primary URL. A replica is not a migration target.",
        },
      },
    );
  }
  const url = typeof input === "string" ? input : input.url;
  const configProtected = typeof input === "string" ? false : input.protected === true;
  if (url === undefined || url.length === 0) {
    throw new OkmError("OKM1845", `Target ${name} has no url.`, {
      fix: { summary: "Set the target url. A target is not inferred from the environment." },
    });
  }
  const endpoint = endpointOf(url);
  const inStore = fingerprints.has(
    hostDbFingerprint(endpoint.host, endpoint.port, endpoint.database),
  );
  const protection = protectionMatch(configProtected, inStore);
  return {
    name,
    url,
    protected: protection !== "open",
    protection,
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
  };
}

function protectionMatch(configProtected: boolean, inStore: boolean): ProtectionMatch {
  if (configProtected && inStore) return "project-and-store";
  if (inStore) return "store";
  if (configProtected) return "project";
  return "open";
}

function isReplicaTarget(input: object): boolean {
  return "primary" in input || "replicas" in input || "weight" in input || "pool" in input;
}

function endpointOf(url: string): { host: string; port: string; database: string } {
  return postgresEndpoint(url);
}
