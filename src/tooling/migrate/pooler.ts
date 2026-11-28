/**
 * One pooler detector for apply, doctor, session settings, and login probes.
 *
 * A transaction-mode pooler can keep one backend pid for an idle client, so
 * a stable idle pid is not proof of a direct connection. The proof is eight
 * clients at once, opened only when no URL or config signal matched. A pid
 * change on one client, or fewer backends than
 * clients, means pooled. One stable pid per client means direct. A URL
 * signal is pooled either way, and the eight clients are not opened then.
 */

import { OkmError } from "../../contracts/error.js";
import { poolerUrlSignal } from "../../dialects/pg/pooler-url.js";
import { tagOutcome } from "../cli/outcome.js";

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
  /** Eight clients at once. N stable distinct pids is proven direct. */
  readonly concurrent?: ConcurrentPids;
};

/**
 * Decides whether a URL or a probe is pooled.
 *
 * Any one signal is enough: a pooler host, port 6543 or 6432, `pgbouncer=true`,
 * the config marker, or a concurrent probe that shared backends. A stable
 * idle pid is not a signal and is not direct. The result does not contain
 * the URL.
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
 * Throws OKM1854 when the detector says pooled and the caller did not opt in.
 *
 * Opting in does not make the URL direct. Session settings stay off.
 *
 * @param detection - Result of {@link detectPooler}
 * @param allowPooler - The invocation opted in
 */
export function refusePooler(detection: PoolerDetection, allowPooler: boolean): void {
  if (allowPooler || !detection.pooled) return;
  throw tagOutcome(
    new OkmError("OKM1854", poolerMessage(detection), {
      fix: { summary: "Use a direct connection." },
    }),
    "unreachable",
  );
}

/**
 * Refuses a URL that looks pooled unless the caller opted in.
 *
 * This reads the URL only. It does not open a client. A quiet URL is not
 * proven direct.
 *
 * @param url - Target URL
 * @param allowPooler - The invocation opted in
 */
export function assertDirectConnection(url: string, allowPooler: boolean): void {
  refusePooler(detectPooler({ url, marker: allowPooler }), allowPooler);
}

function concurrentSignal(concurrent: ConcurrentPids | undefined): "pooled" | "direct" | undefined {
  if (concurrent === undefined) return undefined;
  if (concurrent.changed || concurrent.distinct < concurrent.clients) return "pooled";
  if (concurrent.clients > 0 && concurrent.distinct === concurrent.clients) return "direct";
  return undefined;
}

function urlSignal(url: string): { signal: PoolerSignal; detail: string } | undefined {
  return poolerUrlSignal(url);
}
