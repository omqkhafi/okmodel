/**
 * `using` exists on a topology client only.
 *
 * A string or pool client has no such member. A derived client has no `close`
 * and no `using`.
 */

import { expectTypeOf } from "expect-type";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/pglite.js";
import type { ReplicaCandidate, TopologyOptions } from "../src/runtime/topology.js";

const notes = table("notes", { id: t.text().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

type Has<T, K extends string> = K extends keyof T ? true : false;

void (async () => {
  const plain = await connect("memory://plain", { schema: app });
  expectTypeOf<Has<typeof plain, "using">>().toEqualTypeOf<false>();
  void plain.notes.find({ limit: 1, route: "primary" });
  void plain.notes.find({ limit: 1, route: "replica" });

  const routed = await connect(
    { primary: "memory://primary", replicas: ["memory://east"] },
    { schema: app },
  );
  expectTypeOf<Has<typeof routed, "using">>().toEqualTypeOf<true>();
  const scoped = routed.using("replica");
  expectTypeOf<Has<typeof scoped, "close">>().toEqualTypeOf<false>();
  expectTypeOf<Has<typeof scoped, "using">>().toEqualTypeOf<false>();
  expectTypeOf<Has<typeof scoped, "notes">>().toEqualTypeOf<true>();

  await connect(
    { primary: "memory://primary", replicas: [{ url: "memory://east", weight: 2, name: "east" }] },
    {
      schema: app,
      routing: {
        select(candidates, ctx) {
          expectTypeOf(candidates).toEqualTypeOf<readonly ReplicaCandidate[]>();
          expectTypeOf(ctx).toEqualTypeOf<{ readonly op: "read" }>();
          const candidate = candidates[0];
          if (candidate === undefined) return "east";
          expectTypeOf(candidate.name).toEqualTypeOf<string>();
          expectTypeOf(candidate.weight).toEqualTypeOf<number>();
          expectTypeOf(candidate.inflight).toEqualTypeOf<number>();
          expectTypeOf(candidate.latencyMs).toEqualTypeOf<number | null>();
          expectTypeOf(candidate.lag).toEqualTypeOf<number | null>();
          return candidate;
        },
      },
    },
  );
});

type Select = NonNullable<NonNullable<TopologyOptions["routing"]>["select"]>;

expectTypeOf<"weighted" | "roundRobin" | "leastConnections" | "latencyAware">().toEqualTypeOf<
  Extract<Select, string>
>();

// @ts-expect-error an unknown strategy name is not a select option
const badName: Select = "first";
void badName;

// @ts-expect-error select is a strategy name or a function
const badType: Select = 1;
void badType;

type Consistency = NonNullable<NonNullable<TopologyOptions["routing"]>["consistency"]>;
type MaxLag = NonNullable<NonNullable<TopologyOptions["routing"]>["maxLag"]>;

expectTypeOf<"session" | "eventual">().toEqualTypeOf<Consistency>();
expectTypeOf<MaxLag>().toEqualTypeOf<string>();

const session: Consistency = "session";
const eventual: Consistency = "eventual";
const lag: MaxLag = "5s";
void session;
void eventual;
void lag;

// @ts-expect-error consistency is session or eventual
const badConsistency: Consistency = "linear";
void badConsistency;

// @ts-expect-error maxLag is a string, so a bare number is not a unit
const badLag: MaxLag = 5;
void badLag;
