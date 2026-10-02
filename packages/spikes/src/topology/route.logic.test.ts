/**
 * Router decisions without a database.
 *
 * The property tests are the guarantee that a primary-required operation is
 * not given a replica, and that `.replica()` does not return the primary.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import { TopologyError } from "./error.js";
import { lagTimeMs, parseMaxLag, withinLag } from "./lag.js";
import { applyProbe, forwardLsn, initialProbe } from "./probe.js";
import { decideRoute } from "./route.js";
import { emptyMark, noteCommit } from "./session.js";
import {
  initialSelectState,
  type OperationKind,
  type ReplicaView,
  type RouteConstraint,
  type RoutingPolicy,
  type SelectState,
} from "./types.js";

const PRIMARY_KINDS = ["write", "batch", "locking-read", "advisory-lock", "tx"] as const;

const basePolicy: RoutingPolicy = {
  select: "roundRobin",
  consistency: "session",
  fallback: "primary",
  maxLag: null,
  probeMs: 0,
};

function replica(name: string, patch: Partial<ReplicaView> = {}): ReplicaView {
  return {
    name,
    weight: 1,
    healthy: true,
    circuitOpen: false,
    replayLsn: "0/20",
    lagBytes: 0n,
    lagMs: 0,
    inflight: 0,
    waiting: 0,
    idle: 2,
    saturated: false,
    latencyMs: 1,
    positionCapable: true,
    ...patch,
  };
}

function decide(
  kind: OperationKind,
  replicas: readonly ReplicaView[],
  patch: {
    readonly constraint?: RouteConstraint;
    readonly policy?: Partial<RoutingPolicy>;
    readonly watermark?: string | null;
    readonly positionUnknown?: boolean;
    readonly positionCapable?: boolean;
    readonly state?: SelectState;
    readonly random?: () => number;
  } = {},
) {
  return decideRoute({
    kind,
    constraint: patch.constraint ?? { kind: "auto" },
    policy: { ...basePolicy, ...patch.policy },
    replicas,
    watermark: patch.watermark ?? null,
    positionUnknown: patch.positionUnknown ?? false,
    positionCapable: patch.positionCapable ?? true,
    state: patch.state ?? initialSelectState(),
    random: patch.random ?? (() => 0),
  });
}

test("routing.property: primary-required decisions are the primary", () => {
  const replicas = fc.uniqueArray(
    fc.record({
      name: fc.constantFrom("a", "b", "c"),
      weight: fc.integer({ min: 1, max: 5 }),
      healthy: fc.boolean(),
      saturated: fc.boolean(),
      lagBytes: fc.constantFrom(0n, 10n, 5000n),
    }),
    { maxLength: 3, selector: (value) => value.name },
  );
  fc.assert(
    fc.property(
      fc.constantFrom(...PRIMARY_KINDS),
      replicas,
      fc.constantFrom("auto", "primary"),
      (kind, generated, constraint) => {
        const choice = decide(
          kind,
          generated.map((item) =>
            replica(item.name, {
              weight: item.weight,
              healthy: item.healthy,
              saturated: item.saturated,
              lagBytes: item.lagBytes,
              idle: item.saturated ? 0 : 1,
            }),
          ),
          { constraint: constraint === "primary" ? { kind: "primary" } : { kind: "auto" } },
        );
        expect(choice.decision.endpoint).toBe("primary");
        expect(choice.decision.role).toBe("primary");
        expect(choice.decision.reason).toBe("primary-required");
      },
    ),
    { numRuns: 200 },
  );
});

test("routing.property: .replica() on a primary-required operation is OKM1840", () => {
  fc.assert(
    fc.property(fc.constantFrom(...PRIMARY_KINDS), (kind) => {
      expect(() => decide(kind, [replica("a")], { constraint: { kind: "replica" } })).toThrow(
        TopologyError,
      );
      try {
        decide(kind, [replica("a")], { constraint: { kind: "replica" } });
      } catch (error) {
        expect(error).toBeInstanceOf(TopologyError);
        if (error instanceof TopologyError) expect(error.code).toBe("OKM1840");
      }
    }),
    { numRuns: 20 },
  );
});

test("routing.strict: .replica() never returns the primary", () => {
  const replicas = fc.uniqueArray(
    fc.record({
      name: fc.constantFrom("a", "b", "c"),
      healthy: fc.boolean(),
      saturated: fc.boolean(),
      behind: fc.boolean(),
    }),
    { maxLength: 3, selector: (value) => value.name },
  );
  fc.assert(
    fc.property(replicas, fc.boolean(), (generated, errorFallback) => {
      const run = (): void => {
        const choice = decide(
          "read",
          generated.map((item) =>
            replica(item.name, {
              healthy: item.healthy,
              saturated: item.saturated,
              idle: item.saturated ? 0 : 1,
              replayLsn: item.behind ? "0/1" : "0/20",
            }),
          ),
          {
            constraint: { kind: "replica" },
            watermark: "0/10",
            policy: { fallback: errorFallback ? "error" : "primary" },
          },
        );
        expect(choice.decision.role).toBe("replica");
        expect(choice.decision.endpoint).not.toBe("primary");
        expect(choice.decision.reason).toBe("constraint:replica");
      };
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(TopologyError);
        if (error instanceof TopologyError) expect(error.code).toBe("OKM1843");
      }
    }),
    { numRuns: 200 },
  );
});

test("routing.auto sends an eligible read to a replica", () => {
  const choice = decide("read", [replica("a"), replica("b")]);
  expect(choice.decision).toEqual({ endpoint: "a", role: "replica", reason: "auto:a" });
});

test("routing.classes keeps the primary out of the replica list", () => {
  expect(() =>
    decide("read", [replica("a")], {
      policy: {
        select: () => "primary",
      },
    }),
  ).toThrow("not an eligible replica");
});

test("a topology with no replicas sends reads to the primary and .replica() is OKM1843", () => {
  const automatic = decide("read", []);
  expect(automatic.decision.reason).toBe("fallback:no-replicas");
  try {
    decide("read", [], { constraint: { kind: "replica" } });
    throw new Error("expected OKM1843");
  } catch (error) {
    expect(error).toBeInstanceOf(TopologyError);
    if (error instanceof TopologyError) {
      expect(error.code).toBe("OKM1843");
      expect(error.fix).toBe("Configure a replica or drop the .replica() constraint.");
    }
  }
});

test(".primary() bypasses selection", () => {
  const choice = decide("read", [replica("a")], { constraint: { kind: "primary" } });
  expect(choice.decision).toEqual({
    endpoint: "primary",
    role: "primary",
    reason: "constraint:primary",
  });
});

test("unhealthy replicas fall back, or fail when fallback is error", () => {
  const fallback = decide("read", [replica("a", { healthy: false })]);
  expect(fallback.decision.reason).toBe("fallback:unhealthy");
  expect(() =>
    decide("read", [replica("a", { healthy: false })], { policy: { fallback: "error" } }),
  ).toThrow(TopologyError);
  try {
    decide("read", [replica("a", { healthy: false })], { policy: { fallback: "error" } });
  } catch (error) {
    if (error instanceof TopologyError) expect(error.code).toBe("OKM1844");
  }
});

test("lag and a session watermark remove replicas before selection", () => {
  const lagged = decide("read", [replica("a", { lagBytes: 100n, lagMs: 0 })], {
    policy: { maxLag: parseMaxLag("16B"), select: "roundRobin" },
  });
  expect(lagged.decision.reason).toBe("fallback:behind");
  const behind = decide("read", [replica("a", { replayLsn: "0/1" })], { watermark: "0/10" });
  expect(behind.decision.reason).toBe("fallback:behind");
  const eventual = decide("read", [replica("a", { replayLsn: "0/1" })], {
    watermark: "0/10",
    constraint: { kind: "replica", consistency: "eventual" },
  });
  expect(eventual.decision.role).toBe("replica");
});

test("a saturated pool is skipped and the free replica is used", () => {
  const choice = decide("read", [
    replica("a", { saturated: true, idle: 0, inflight: 1 }),
    replica("b"),
  ]);
  expect(choice.decision.endpoint).toBe("b");
  const both = decide("read", [
    replica("a", { saturated: true, idle: 0 }),
    replica("b", { saturated: true, idle: 0 }),
  ]);
  expect(both.decision.reason).toBe("fallback:saturated");
});

test("position-unknown and a missing capability keep a session that wrote off replicas", () => {
  const unknown = decide("read", [replica("a")], { positionUnknown: true });
  expect(unknown.decision.reason).toBe("fallback:position-unknown");
  const incapable = decide("read", [replica("a")], {
    watermark: "0/10",
    positionCapable: false,
  });
  expect(incapable.decision.reason).toBe("fallback:position-unknown");
  expect(() =>
    decide("read", [replica("a")], {
      positionUnknown: true,
      constraint: { kind: "replica" },
    }),
  ).toThrow(TopologyError);
});

test("round-robin, weighted, least-loaded, latency, and random pick as specified", () => {
  const replicas = [replica("a"), replica("b")];
  const first = decide("read", replicas, { policy: { select: "roundRobin" } });
  const second = decide("read", replicas, {
    policy: { select: "roundRobin" },
    state: first.state,
  });
  expect([first.decision.endpoint, second.decision.endpoint]).toEqual(["a", "b"]);

  let state = initialSelectState();
  const weighted: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const choice = decide("read", [replica("a", { weight: 2 }), replica("b", { weight: 1 })], {
      policy: { select: "weighted" },
      state,
    });
    weighted.push(choice.decision.endpoint);
    state = choice.state;
  }
  expect(weighted).toEqual(["a", "b", "a", "a", "b", "a"]);

  const least = decide("read", [replica("a", { inflight: 3 }), replica("b", { inflight: 1 })], {
    policy: { select: "leastConnections" },
  });
  expect(least.decision.endpoint).toBe("b");

  const latency = decide(
    "read",
    [replica("a", { latencyMs: 12 }), replica("b", { latencyMs: 2 })],
    { policy: { select: "latencyAware" } },
  );
  expect(latency.decision.endpoint).toBe("b");

  let flip = 0;
  const randoms = [0, 1].map(() => {
    const choice = decide("read", replicas, {
      policy: { select: "random" },
      random: () => (flip++ === 0 ? 0 : 0.99),
    });
    return choice.decision.endpoint;
  });
  expect(randoms).toEqual(["a", "b"]);

  const custom = decide("read", replicas, {
    policy: { select: (candidates) => candidates.find((item) => item.name === "b")?.name ?? "a" },
  });
  expect(custom.decision.endpoint).toBe("b");
});

test("a caught-up replica has zero time lag when its replay timestamp is old", () => {
  const old = Date.now() - 60_000;
  expect(lagTimeMs(0n, old, Date.now())).toBe(0);
  expect(withinLag({ bytes: 0n, ms: 0 }, parseMaxLag("1s"))).toBe(true);
  expect(withinLag({ bytes: null, ms: null }, parseMaxLag("16MB"))).toBe(false);
  const limit = parseMaxLag("16MB");
  expect(limit.kind).toBe("bytes");
  if (limit.kind === "bytes") expect(limit.bytes).toBe(16n * 1024n * 1024n);
});

test("replay cache only moves forward and the circuit opens after consecutive failures", () => {
  expect(forwardLsn("0/20", "0/10")).toBe("0/20");
  expect(forwardLsn("0/10", "0/20")).toBe("0/20");
  let state = initialProbe(0, 1000);
  state = applyProbe(state, { ok: false, latencyMs: 1, positionCapable: true }, 10, 2);
  expect(state.healthy).toBe(false);
  expect(state.circuitOpen).toBe(false);
  state = applyProbe(state, { ok: false, latencyMs: 1, positionCapable: true }, 20, 2);
  expect(state.circuitOpen).toBe(true);
  state = applyProbe(
    state,
    { ok: true, latencyMs: 4, positionCapable: true, replayLsn: "0/30" },
    30,
    2,
  );
  expect(state.healthy).toBe(true);
  expect(state.circuitOpen).toBe(false);
  expect(state.replayLsn).toBe("0/30");
});

test("a replica that cannot read positions is not used after a write", () => {
  const choice = decide("read", [replica("a", { positionCapable: false, replayLsn: "0/20" })], {
    watermark: "0/10",
  });
  expect(choice.decision.reason).toBe("fallback:position-unknown");
  expect(() =>
    decide("read", [replica("a", { positionCapable: false })], {
      watermark: "0/10",
      constraint: { kind: "replica" },
    }),
  ).toThrow(TopologyError);
});

test("a session watermark is monotonic per mark", () => {
  const root = emptyMark();
  const other = emptyMark();
  noteCommit(root, "0/20");
  noteCommit(root, "0/10");
  noteCommit(other, "0/5");
  expect(root.lsn).toBe("0/20");
  expect(other.lsn).toBe("0/5");
});
