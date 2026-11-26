/**
 * One pooler detector for apply, doctor, session settings, and login probes.
 *
 * A transaction-mode pooler can keep one backend pid for an idle client, so
 * that check is advisory: a stable pid is not proof of a direct connection.
 * The proof is eight clients at once. Each runs a few statements while the
 * others run. A pid change on one client, or fewer backends than clients,
 * means pooled. One stable pid per client means direct. A URL signal is
 * pooled either way, and the eight clients are not opened then.
 */

import { OkmError } from "../../contracts/error.js";
import { tagOutcome } from "../cli/outcome.js";
import { postgresEndpoint } from "./fingerprint.js";

/** Which signal decided the connection is pooled. */
export type PoolerSignal = "host" | "port" | "parameter" | "config" | "pid";

/**
 * Result of {@link detectPooler}.
 *
 * `provenDirect` is true only after the concurrent probe saw one stable
 * backend pid per client and no URL or config signal matched. A quiet URL,
 * and a single idle client that kept one pid, are not proof.
 */
export type PoolerDetection = {
  readonly pooled: boolean;
  readonly provenDirect: boolean;
  /** Set when {@link PoolerDetection.pooled} is true. */
  readonly signal?: PoolerSignal;
  /** Words for a message. No host, user, password, or port value. */
  readonly detail?: string;
};

/**
 * What eight overlapping clients saw.
 *
 * `changed` is true when one client read more than one backend pid.
 * `distinct` counts backends across the clients.
 */
export type ConcurrentPids = {
  readonly clients: number;
  readonly distinct: number;
  readonly changed: boolean;
};

/** What {@link detectPooler} reads. The URL is never copied into the result. */
export type PoolerInput = {
  readonly url: string;
  /** `allowPooler` on the command or in the config. */
  readonly marker?: boolean;
  /**
   * Single idle client.
   *
   * `true` means the pid changed, which is a pooled signal. `false` means the
   * pid stayed put. That is not detected, and it is not direct.
   */
  readonly pidChanged?: boolean;
  /** Eight clients at once. N stable distinct pids is proven direct. */
  readonly concurrent?: ConcurrentPids;
};

/**
 * Decides whether a URL or a probe is pooled.
 *
 * Any one signal is enough: a pooler host, port 6543 or 6432, `pgbouncer=true`,
 * the config marker, a concurrent probe that shared backends, or an idle pid
 * that changed. A stable idle pid is not detected and is not direct. The
 * result does not contain the URL.
 *
 * @param input - URL, optional marker, and optional probes
 * @returns Pooled, or proven direct when eight clients kept eight pids
 */
export function detectPooler(input: PoolerInput): PoolerDetection {
  const urlHit = urlSignal(input.url);
  if (urlHit !== undefined) {
    return { pooled: true, provenDirect: false, signal: urlHit.signal, detail: urlHit.detail };
  }
  if (input.marker === true) {
    return {
      pooled: true,
      provenDirect: false,
      signal: "config",
      detail: "allowPooler is set",
    };
  }
  const concurrent = concurrentSignal(input.concurrent);
  if (concurrent === "pooled") {
    const changed = input.concurrent?.changed === true;
    return {
      pooled: true,
      provenDirect: false,
      signal: "pid",
      detail: changed
        ? "a backend pid changed across concurrent clients"
        : "fewer backends than clients",
    };
  }
  if (concurrent === "direct") return { pooled: false, provenDirect: true };
  if (input.pidChanged === true) {
    return {
      pooled: true,
      provenDirect: false,
      signal: "pid",
      detail: "the backend pid changed",
    };
  }
  return { pooled: false, provenDirect: false };
}

/**
 * The URL part {@link detectPooler} would name, ignoring the config marker and the pid.
 *
 * @param url - Target URL
 * @returns The part, or `undefined` when the URL does not look pooled
 */
export function poolerSignal(url: string): PoolerSignal | undefined {
  return urlSignal(url)?.signal;
}

/**
 * Sentence for a pooled migration URL.
 *
 * The signal is named. The host, the user, the password, and the port value
 * are not.
 *
 * @param detection - A pooled result
 * @returns The sentence, with no trailing newline
 */
export function poolerMessage(detection: PoolerDetection): string {
  const which = detection.detail ?? detection.signal ?? "a pooler signal";
  return `The migration URL is a pooler (${which}). Use a direct URL for migrations.`;
}

/**
 * Refuses a URL that looks pooled unless the caller opted in.
 *
 * Opting in does not make the URL direct. Session settings stay off.
 *
 * @param url - Target URL
 * @param allowPooler - The invocation opted in
 */
export function assertDirectConnection(url: string, allowPooler: boolean): void {
  if (allowPooler) return;
  const found = detectPooler({ url });
  if (!found.pooled) return;
  throw tagOutcome(
    new OkmError("OKM1854", poolerMessage(found), {
      fix: { summary: "Use a direct connection." },
    }),
    "unreachable",
  );
}

/** Holds another backend between pid reads. Resolves to a release function. */
export type StableBackendOptions = {
  readonly holdBackend?: () => Promise<() => Promise<void>>;
};

/**
 * Reads eight backend pids on one idle client.
 *
 * A change is a pooled signal and throws OKM1854. A stable pid is advisory:
 * the result is not proven direct. `--allow-pooler` and a URL signal skip the
 * reads.
 *
 * @param url - Target URL
 * @param readPid - Reads `pg_backend_pid()` on the session under test
 * @param allowPooler - The invocation opted in
 * @param options - Optional hold used by the migrate warm-and-hold probe
 * @returns The detector result. `provenDirect` stays false
 */
export async function probePooler(
  url: string,
  readPid: () => Promise<string>,
  allowPooler: boolean,
  options?: StableBackendOptions,
): Promise<PoolerDetection> {
  const hinted = detectPooler({ url, marker: allowPooler });
  if (hinted.pooled || allowPooler) return hinted;
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
        const found = detectPooler({ url, pidChanged: true });
        throw new OkmError(
          "OKM1854",
          `The backend pid changed from ${first} to ${second}. ${poolerMessage(found)}`,
          { fix: { summary: "Use a direct connection." } },
        );
      }
      if (release !== undefined) {
        await release();
        release = undefined;
      }
      if (i < 7 && options?.holdBackend !== undefined) release = await options.holdBackend();
    }
  } finally {
    if (release !== undefined) await release().catch(() => undefined);
  }
  return detectPooler({ url, pidChanged: false });
}

function concurrentSignal(concurrent: ConcurrentPids | undefined): "pooled" | "direct" | undefined {
  if (concurrent === undefined) return undefined;
  if (concurrent.changed || concurrent.distinct < concurrent.clients) return "pooled";
  if (concurrent.clients > 0 && concurrent.distinct === concurrent.clients) return "direct";
  return undefined;
}

function urlSignal(url: string): { signal: PoolerSignal; detail: string } | undefined {
  let endpoint: { host: string; port: string };
  let parsed: URL;
  try {
    endpoint = postgresEndpoint(url);
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = endpoint.host;
  if (host.includes("-pooler")) return { signal: "host", detail: "the host name contains -pooler" };
  if (host.includes(".pooler.supabase.com")) {
    return { signal: "host", detail: "the host name contains .pooler.supabase.com" };
  }
  if (host.includes("pooler") || host.includes("pgbouncer")) {
    return { signal: "host", detail: "a pooler host" };
  }
  if (endpoint.port === "6543" || endpoint.port === "6432") {
    return { signal: "port", detail: "the port (6543 or 6432)" };
  }
  if (parsed.searchParams.get("pgbouncer") === "true") {
    return { signal: "parameter", detail: "the pgbouncer=true parameter" };
  }
  return undefined;
}
