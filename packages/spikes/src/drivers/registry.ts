/**
 * Capability registry for the driver spike.
 *
 * The registry is data. A declared capability that has no conformance test
 * fails `assertRegistryLinked`. Atomic `batch` is not a capability; its tests
 * are contract tests and are required for every adapter.
 */

import type { DriverCapabilityFlags, PreparedMode } from "./types.js";

/** One driver in the registry. */
export type DriverManifest = {
  /** Adapter id used in the compatibility table. */
  readonly id: "postgresjs" | "pglite" | "batch-mode";
  /** Dialect this manifest is about. */
  readonly dialect: "postgres";
  /** Declared execution flags. */
  readonly capabilities: DriverCapabilityFlags;
  /** Prepared modes the adapter will honour. */
  readonly preparedModes: readonly PreparedMode[];
  /** Declared capability → conformance test id. */
  readonly links: readonly CapabilityLink[];
};

/** A declared capability and the test that must pass for it. */
export type CapabilityLink = {
  /** Capability name. */
  readonly capability: string;
  /** Conformance test id. */
  readonly testId: string;
};

/**
 * Contract tests. They are not capability flags.
 *
 * Every adapter runs them. A test may still skip when it needs a flag the
 * adapter did not declare; the skip reason is recorded.
 */
export const CONTRACT_TESTS = [
  "execute.rows",
  "execute.params",
  "execute.codecs",
  "execute.notices",
  "execute.errors",
  "signal.preaborted",
  "batch.atomic.success",
  "batch.atomic.failure",
  "batch.atomic.deferred",
  "batch.atomic.sequences",
  "batch.atomic.cancel",
  "batch.atomic.timeout",
  "batch.atomic.savepoint",
  "batch.atomic.outcome",
  "timeout.declaration",
  "stats.shape",
] as const;

const POSTGRESJS: DriverManifest = {
  id: "postgresjs",
  dialect: "postgres",
  capabilities: {
    transactions: "interactive",
    stream: true,
    listen: true,
    cancel: true,
    prepared: "named",
    describe: true,
  },
  preparedModes: ["named", "unnamed", "none"],
  links: [
    { capability: "transactions.interactive", testId: "transactions.interactive" },
    { capability: "stream", testId: "stream.cursor" },
    { capability: "listen", testId: "listen.notify" },
    { capability: "cancel", testId: "execute.cancel" },
    { capability: "describe", testId: "describe.query" },
    { capability: "prepared.named", testId: "prepared.named" },
    { capability: "prepared.unnamed", testId: "prepared.unnamed" },
    { capability: "prepared.none", testId: "prepared.none" },
  ],
};

const PGLITE: DriverManifest = {
  id: "pglite",
  dialect: "postgres",
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: true,
    cancel: false,
    prepared: "unnamed",
    describe: true,
  },
  preparedModes: ["unnamed", "none"],
  links: [
    { capability: "transactions.interactive", testId: "transactions.interactive" },
    { capability: "listen", testId: "listen.notify" },
    { capability: "describe", testId: "describe.query" },
    { capability: "prepared.unnamed", testId: "prepared.unnamed" },
    { capability: "prepared.none", testId: "prepared.none" },
  ],
};

const BATCH_MODE: DriverManifest = {
  id: "batch-mode",
  dialect: "postgres",
  capabilities: {
    transactions: "batch",
    stream: false,
    listen: false,
    cancel: true,
    prepared: "none",
    describe: false,
  },
  preparedModes: ["none"],
  links: [
    { capability: "transactions.batch", testId: "transactions.batch" },
    { capability: "cancel", testId: "execute.cancel" },
    { capability: "prepared.none", testId: "prepared.none" },
  ],
};

/** The three adapters this spike opens. */
export const MANIFESTS: readonly DriverManifest[] = [POSTGRESJS, PGLITE, BATCH_MODE];

/**
 * Returns the manifest for one adapter.
 *
 * @param id - Adapter id
 * @returns The manifest
 */
export function manifestFor(id: DriverManifest["id"]): DriverManifest {
  const found = MANIFESTS.find((manifest) => manifest.id === id);
  if (found === undefined) throw new Error(`unknown driver ${id}`);
  return found;
}

/**
 * Capability ids implied by the flags and the prepared modes.
 *
 * @param manifest - One adapter
 * @returns The capability names that must have a test
 */
export function declaredCapabilities(manifest: DriverManifest): readonly string[] {
  const flags = manifest.capabilities;
  const names: string[] = [
    flags.transactions === "interactive" ? "transactions.interactive" : "transactions.batch",
  ];
  if (flags.stream) names.push("stream");
  if (flags.listen) names.push("listen");
  if (flags.cancel) names.push("cancel");
  if (flags.describe) names.push("describe");
  for (const mode of manifest.preparedModes) names.push(`prepared.${mode}`);
  return names;
}

/**
 * Fails when a declared capability has no test, or a link points at an unknown test.
 *
 * @param caseIds - Conformance test ids the suite registers
 */
export function assertRegistryLinked(caseIds: readonly string[]): void {
  const known = new Set(caseIds);
  for (const id of CONTRACT_TESTS) {
    if (!known.has(id)) throw new Error(`contract test ${id} is not in the suite`);
  }
  for (const manifest of MANIFESTS) {
    if (!manifest.preparedModes.includes(manifest.capabilities.prepared)) {
      throw new Error(`${manifest.id} default prepared mode is not in preparedModes`);
    }
    const expected = new Set(declaredCapabilities(manifest));
    const linked = new Set<string>();
    for (const link of manifest.links) {
      if (linked.has(link.capability)) {
        throw new Error(`${manifest.id} links ${link.capability} twice`);
      }
      linked.add(link.capability);
      if (!known.has(link.testId)) {
        throw new Error(
          `${manifest.id} capability ${link.capability} points at missing test ${link.testId}`,
        );
      }
    }
    for (const capability of expected) {
      if (!linked.has(capability)) {
        throw new Error(`${manifest.id} declares ${capability} without a conformance test`);
      }
    }
    for (const capability of linked) {
      if (!expected.has(capability)) {
        throw new Error(`${manifest.id} links ${capability}, which the flags do not declare`);
      }
    }
    JSON.parse(JSON.stringify(manifest));
  }
}
