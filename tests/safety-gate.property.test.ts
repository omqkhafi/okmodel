/**
 * `safety.property`, the full composition (spec 5.3, P30).
 *
 * P21 built the verifier and P22 to P28 each registered rules. This file registers
 * every one of them together (`exposure`, `tenancy`, `timestamps`, `archive`,
 * `presets`) and runs real queries on real Postgres with the gate schema. D160
 * said the registry alone proves only that the registry works, so each property
 * also asserts on rows, errors, the statements that reached the driver, and
 * `inspect()`:
 *
 * - guarded and sealed fields never reach a write, unless `allow` names a guarded one;
 * - hidden fields never reach a default projection, at any depth of an include;
 * - every read has a bound, or `.all(reason)` with a reason;
 * - presets never remove a predicate: the tenant, the active set and the caller's
 *   filter survive any chain, and a preset read is a subset of the same read without.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import fc from "fast-check";

import { OkmError } from "../src/contracts/error.js";
import { eq } from "../src/dialects/pg/index.js";
import {
  registerArchive,
  registerFieldExposure,
  registerPresets,
  registerTenancy,
  registerTimestamps,
  safetyProperty,
  SafetyError,
  verify,
  type SafetyInput,
} from "../src/runtime/safety/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { SQL_NAME, withGate, type GateEnv } from "./gate-env.js";
import {
  handle,
  PRESETS,
  readOp,
  runLeaf,
  seed,
  tenantsIn,
  type Client,
  type Handle,
  type ReadOp,
  type Step,
} from "./gate-ops.js";
import { assertGate } from "./gate-property.js";
import { tenantProblems } from "./gate-recorder.js";
import { key, TENANT_A, TENANT_B, type TenantTable } from "./gate-schema.js";

const gate = await loadPostgresGate();
const TABLES = Object.values(SQL_NAME);

const stops: (() => void)[] = [];
beforeAll(() => {
  stops.push(
    registerFieldExposure(),
    registerTenancy(),
    registerTimestamps(),
    registerArchive(),
    registerPresets(),
  );
});
afterAll(() => {
  for (const stop of stops) stop();
});

type Settled = { readonly ok: unknown } | { readonly error: OkmError };

async function settle(fn: () => PromiseLike<unknown>): Promise<Settled> {
  try {
    return { ok: await fn() };
  } catch (error) {
    if (error instanceof OkmError) return { error };
    throw error;
  }
}

/** Fills both tenants with the seed rows, directly through the client. */
async function seeded(env: GateEnv): Promise<{ a: Client; b: Client }> {
  await env.clear();
  const a = env.db.for({ tenantId: TENANT_A }) as unknown as Client;
  const b = env.db.for({ tenantId: TENANT_B }) as unknown as Client;
  const rows: Step[] = [...seed(0), ...seed(1)];
  for (const step of rows) {
    if (step.op.t !== "insert") continue;
    await runLeaf(step.who === 0 ? a : b, step.op);
  }
  // Starred and rich projects, an urgent task, so presets have rows to keep and drop.
  for (const client of [a, b]) {
    await (handle(client, "projects", "active", []) as Handle).update?.({
      where: { id: key("p", 0) },
      set: { starred: true, budget: 500 },
    });
    await (handle(client, "tasks", "active", []) as Handle).update?.({
      where: { id: key("t", 0) },
      set: { priority: 4 },
    });
  }
  env.drain();
  return { a, b };
}

// ── guarded and sealed fields ───────────────────────────────────────────────

/** Fields a write must refuse, per table, with a value the field would accept. */
const FORBIDDEN: Readonly<Record<string, readonly (readonly [string, unknown])[]>> = {
  orgs: [
    ["createdAt", "2000-01-01T00:00:00Z"],
    ["updatedAt", "2000-01-01T00:00:00Z"],
    ["archivedAt", "2000-01-01T00:00:00Z"],
    ["archiveId", "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9f01"],
    ["tenantId", TENANT_B],
  ],
  projects: [
    ["createdAt", "2000-01-01T00:00:00Z"],
    ["archivedAt", "2000-01-01T00:00:00Z"],
    ["archiveId", "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9f01"],
    ["tenantId", TENANT_B],
    ["tier", "evil-tier"],
  ],
  tasks: [
    ["updatedAt", "2000-01-01T00:00:00Z"],
    ["archivedAt", "2000-01-01T00:00:00Z"],
    ["tenantId", TENANT_B],
  ],
  labels: [
    ["archivedAt", "2000-01-01T00:00:00Z"],
    ["archiveId", "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9f01"],
    ["tenantId", TENANT_B],
  ],
};

const GUARDED_TABLES = Object.keys(FORBIDDEN);

function baseRow(table: string): Record<string, unknown> {
  const n = 3;
  switch (table) {
    case "orgs":
      return { id: key("o", n), name: "guard" };
    case "projects":
      return { id: key("p", n), orgId: key("o", 0), name: "guard" };
    case "tasks":
      return { id: key("t", n), projectId: key("p", 0), title: "guard" };
    default:
      return { id: key("l", n), name: "guard" };
  }
}

type ForbiddenCase = {
  readonly table: string;
  readonly pick: number;
  readonly how: "insert" | "update" | "batch" | "tx" | "insertMany";
  readonly allow: boolean;
};

postgresTest(
  gate,
  "safety.property: a guarded or sealed field never reaches a write",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const { a } = await seeded(env);
      await assertGate(
        "safety.property guarded",
        fc.asyncProperty(
          fc.record<ForbiddenCase>({
            table: fc.constantFrom(...GUARDED_TABLES),
            pick: fc.nat(8),
            how: fc.constantFrom("insert", "update", "batch", "tx", "insertMany"),
            allow: fc.boolean(),
          }),
          async (input) => {
            const options = FORBIDDEN[input.table]!;
            const [field, value] = options[input.pick % options.length]!;
            // `tier` is guarded, so `allow` may name it. Sealed fields and the tenant key never.
            const allowed = input.allow && field === "tier";
            const table = input.table as TenantTable;
            const row = { ...baseRow(input.table), [field]: value };
            const set = { [field]: value };
            const opts = input.allow ? { allow: [field] } : undefined;
            const before = await env.snapshot(TENANT_A);
            const beforeB = await env.snapshot(TENANT_B);
            env.drain();
            const t = (c: Client): Handle => c[table] as Handle;
            const settled = await settle(() => {
              switch (input.how) {
                case "insert":
                  return t(a).insert!(row, opts) as PromiseLike<unknown>;
                case "insertMany":
                  return t(a).insert!([row], opts) as PromiseLike<unknown>;
                case "update":
                  return t(a).update!(
                    { where: { id: key("o", 0) }, set },
                    opts,
                  ) as PromiseLike<unknown>;
                case "batch":
                  return (a as unknown as { batch(ops: unknown[]): PromiseLike<unknown> }).batch([
                    t(a).insert!(row, opts) as PromiseLike<unknown>,
                  ]);
                case "tx":
                  return (
                    a as unknown as {
                      tx(fn: (c: Client) => Promise<unknown>): PromiseLike<unknown>;
                    }
                  ).tx((c) => t(c).insert!(row, opts) as Promise<unknown>);
              }
            });
            const wire = JSON.stringify(env.rec.log);
            if (allowed && input.how !== "update") {
              // The one open door: a guarded field named in `allow`.
              expect("ok" in settled).toBe(true);
              expect(wire).toContain(String(value));
            } else {
              expect("error" in settled).toBe(true);
              expect(wire.includes(String(value))).toBe(false);
              expect(env.rec.log.filter((s) => /^(insert|update|delete)/i.test(s.text))).toEqual(
                [],
              );
              if (!allowed) expect(await env.snapshot(TENANT_A)).toBe(before);
            }
            expect(await env.snapshot(TENANT_B)).toBe(beforeB);
            expect(env.audits.filter((audit) => audit.tenant === TENANT_B)).toEqual([]);
            // A rejected insert left nothing for the next case to trip on.
            await env.sql.unsafe(
              `delete from ${SQL_NAME[table]} where id = $1 and tenant_id = $2`,
              [String(baseRow(input.table).id), TENANT_A],
            );
          },
        ),
        150,
      );
    });
  },
  300_000,
);

// ── hidden fields ───────────────────────────────────────────────────────────

const HIDDEN_FIELDS = ["apiKey", "notes"] as const;
const HIDDEN_COLUMNS = ['"api_key"', '"notes"'] as const;

postgresTest(
  gate,
  "safety.property: a hidden field never reaches a default projection, at any depth",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const { a } = await seeded(env);
      await env.sql.unsafe(`update orgs set api_key = 'ORG-SECRET-VALUE'`);
      await env.sql.unsafe(`update projects set notes = 'PROJECT-SECRET-NOTE'`);
      await assertGate(
        "safety.property hidden",
        fc.asyncProperty(readOp, async (op: ReadOp) => {
          env.drain();
          const rows = await runLeaf(a, op);
          const text = JSON.stringify(rows);
          expect(text.includes("ORG-SECRET-VALUE")).toBe(false);
          expect(text.includes("PROJECT-SECRET-NOTE")).toBe(false);
          const walk = (value: unknown): void => {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value !== null && typeof value === "object") {
              for (const [name, item] of Object.entries(value)) {
                expect((HIDDEN_FIELDS as readonly string[]).includes(name)).toBe(false);
                walk(item);
              }
            }
          };
          walk(rows);
          // The projection in the statement does not name the column either.
          for (const statement of env.rec.log) {
            for (const column of HIDDEN_COLUMNS) {
              const selected = statement.text.split(/ from /i)[0] ?? "";
              if (/^select /i.test(statement.text)) expect(selected.includes(column)).toBe(false);
            }
          }
        }),
        150,
      );

      // Naming the field in `select` is the one way to see it, and the value then shows.
      const named = (await (a.projects as Handle).find!({
        select: ["id", "notes"],
        limit: 3,
      })) as { notes: string }[];
      expect(named[0]?.notes).toBe("PROJECT-SECRET-NOTE");
      // `inspect()` says the field was excluded and never prints its value.
      const view = await (
        (a.projects as Handle).find!({ limit: 3 }) as {
          inspect(): Promise<{ rules: { rule: string; contribution: string }[] }>;
        }
      ).inspect();
      expect(
        view.rules.some((rule) => rule.rule === "hidden" && rule.contribution.includes("excluded")),
      ).toBe(true);
      expect(JSON.stringify(view).includes("PROJECT-SECRET-NOTE")).toBe(false);
    });
  },
  300_000,
);

// ── bounds ──────────────────────────────────────────────────────────────────

type Bound = {
  readonly table: "projects" | "orgs" | "labels";
  readonly limit: boolean;
  readonly include: "none" | "boundedMany" | "unboundedMany" | "one";
  readonly all: "none" | "reason" | "blank";
};

const TO_MANY: Readonly<Record<string, string>> = {
  projects: "tasks",
  orgs: "projects",
  labels: "projects",
};

postgresTest(
  gate,
  "safety.property: every read has a bound, or .all with a reason",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const { a } = await seeded(env);
      await assertGate(
        "safety.property bounds",
        fc.asyncProperty(
          fc.record<Bound>({
            table: fc.constantFrom("projects", "orgs", "labels"),
            limit: fc.boolean(),
            include: fc.constantFrom("none", "boundedMany", "unboundedMany", "one"),
            all: fc.constantFrom("none", "reason", "blank"),
          }),
          async (input) => {
            const many = TO_MANY[input.table]!;
            const include =
              input.include === "none"
                ? undefined
                : input.include === "boundedMany"
                  ? { [many]: { limit: 2 } }
                  : input.include === "unboundedMany"
                    ? { [many]: true }
                    : input.table === "projects"
                      ? { org: true }
                      : undefined;
            const options = {
              ...(input.limit ? { limit: 3 } : {}),
              ...(include !== undefined ? { include } : {}),
            };
            type Q = PromiseLike<unknown> & {
              all(reason: string): Q;
              inspect(): Promise<{ rules: { rule: string }[] }>;
            };
            const make = (): Q => {
              const read = (a[input.table] as Handle).find!(options) as Q;
              if (input.all === "none") return read;
              return read.all(input.all === "reason" ? "export for the audit" : "  ");
            };
            env.drain();
            const settled = await settle(() => make());
            const unbounded =
              !input.limit || (input.include === "unboundedMany" && include !== undefined);
            const expectOk = input.all === "reason" || (input.all === "none" && !unbounded);
            expect("ok" in settled, JSON.stringify(input)).toBe(expectOk);
            if ("error" in settled) {
              // Nothing was sent for a read that was refused.
              expect(env.rec.log).toEqual([]);
              expect(["OKM1101", "OKM1105", "OKM1190"]).toContain(settled.error.code);
            } else {
              // The read that ran says why it was allowed to run.
              const inspected = await make().inspect();
              expect(inspected.rules.some((rule) => rule.rule === "bounded")).toBe(true);
            }
          },
        ),
        120,
      );

      // aggregate groups need a bound too; a blank reason is not one.
      const group = (a.tasks as Handle).aggregate!({ groupBy: ["priority"], count: true }) as {
        all(reason: string): PromiseLike<unknown>;
      } & PromiseLike<unknown>;
      expect("error" in (await settle(() => group))).toBe(true);
      expect("error" in (await settle(() => group.all("  ")))).toBe(true);
      expect("ok" in (await settle(() => group.all("every group")))).toBe(true);
    });
  },
  300_000,
);

// ── presets ─────────────────────────────────────────────────────────────────

const presetPick = fc.record({
  table: fc.constantFrom<"projects" | "tasks">("projects", "tasks"),
  chain: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 3 }),
  view: fc.constantFrom<"active" | "with" | "only">("active", "with", "only"),
  caller: fc.constantFrom<"none" | "name" | "id">("none", "name", "id"),
  read: fc.constantFrom<"find" | "count" | "exists" | "one">("find", "count", "exists", "one"),
});

postgresTest(
  gate,
  "safety.property: a preset never removes the tenant, the active set or the caller's filter",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const { a } = await seeded(env);
      // More rows, so a chain has something to drop: archived ones, and other tenants'.
      await (a.projects as Handle).archive!({ where: { id: key("p", 1) } });
      await (a.tasks as Handle).archive!({ where: { id: key("t", 1) } });
      await assertGate(
        "safety.property presets",
        fc.asyncProperty(presetPick, async (input) => {
          const table = input.table;
          const where =
            input.caller === "none"
              ? undefined
              : input.caller === "name"
                ? { [table === "tasks" ? "title" : "name"]: eq("n0") }
                : { id: key(table === "tasks" ? "t" : "p", 0) };
          const run = (chain: readonly number[]): PromiseLike<unknown> => {
            const h = handle(a, table, input.view, chain);
            const filter = where !== undefined ? { where } : {};
            const options = { ...filter, limit: 20 };
            if (input.read === "one") {
              return (h.one as (o: object) => PromiseLike<unknown>)(
                where === undefined ? { where: { id: key("p", 0) } } : { where },
              );
            }
            if (input.read === "find")
              return (h.find as (o: object) => PromiseLike<unknown>)(options);
            if (input.read === "count")
              return (h.count as (o: object) => PromiseLike<unknown>)(filter);
            return (h.exists as (o: object) => PromiseLike<unknown>)(filter);
          };
          env.drain();
          const plain = await settle(() => run([]));
          env.drain();
          const withPresets = await settle(() => run(input.chain));
          const statements = env.rec.log.slice();
          // A preset never turns a refusal into an answer, nor an answer into a refusal.
          expect("ok" in withPresets).toBe("ok" in plain);
          // Every statement keeps the tenant predicate, and the active set unless the view widened it.
          expect(tenantProblems(statements, TENANT_A, [TENANT_B], TABLES)).toEqual([]);
          for (const statement of statements) {
            const text = statement.text;
            if (input.view === "active") expect(text).toContain('"archived_at" is null');
            if (input.view === "only") expect(text).toContain('"archived_at" is not null');
            if (input.view === "with") {
              expect(text.includes('"archived_at" is null')).toBe(false);
            }
            if (where !== undefined && input.caller === "id") {
              expect(statement.params).toContain(key(table === "tasks" ? "t" : "p", 0));
            }
          }
          if ("ok" in plain && "ok" in withPresets) {
            const subset = (value: unknown): string[] => {
              const v = value as unknown;
              if (Array.isArray(v)) return v.map((r: { id: string }) => r.id);
              if (v !== null && typeof v === "object") return [(v as { id: string }).id];
              return [];
            };
            if (input.read === "find") {
              const all = new Set(subset(plain.ok));
              for (const id of subset(withPresets.ok)) expect(all.has(id)).toBe(true);
            }
            if (input.read === "count") {
              expect(Number(withPresets.ok)).toBeLessThanOrEqual(Number(plain.ok));
            }
            if (input.read === "exists" && withPresets.ok === true) expect(plain.ok).toBe(true);
            expect(tenantsIn(withPresets.ok).filter((t) => t !== TENANT_A)).toEqual([]);
          }
        }),
        150,
      );

      // `inspect()` lists the tenant, the active set, the caller's filter and each preset.
      const chain = (a.projects as Handle).starred!() as unknown as Handle;
      const read = (chain.rich as () => Handle)();
      const view = await (
        read.find as (o: object) => {
          inspect(): Promise<{ rules: { rule: string; contribution: string }[] }>;
        }
      )({
        where: { name: eq("n0") },
        limit: 5,
      }).inspect();
      const rules = view.rules.map((rule) => rule.rule);
      expect(rules).toContain("tenancy");
      expect(rules).toContain("archive");
      expect(rules).toContain("filter");
      expect(rules.filter((rule) => rule === "preset")).toHaveLength(2);
      const input: SafetyInput = {
        contributions: view.rules.map((rule) => ({ ...rule, provenance: "inspect()" })),
      };
      expect(safetyProperty([input])[0]).toEqual([]);
      void PRESETS;
    });
  },
  300_000,
);

// ── the registry, with every rule registered ────────────────────────────────

const line = (rule: string, contribution: string): SafetyInput => ({
  contributions: [{ rule, contribution, provenance: "planner" }],
});

postgresTest(
  gate,
  "safety.property: all five rules together name each violation, in a stable order",
  async () => {
    const bad = [
      line("hidden", "hidden projects.notes shown via select"),
      line("sensitive", "sensitive users.token revealed via error"),
      line("guarded", "guarded projects.tier set via update"),
      line("tenancy", "tenancy projects.tenantId set by input via insert"),
      line("timestamps", "timestamps projects.createdAt set by input"),
      line("archive", "archive active set dropped"),
      line("archive", "archive cascade skipped"),
      line("preset", "preset starred removed tenancy"),
      line("preset", "preset rich replaced where"),
    ];
    const good = [
      line("hidden", "hidden projects.notes excluded"),
      line("sensitive", "sensitive users.token redacted"),
      line("guarded", "guarded projects.tier absent"),
      line("tenancy", "tenancy scoped"),
      line("timestamps", "timestamps projects.createdAt kept"),
      line("archive", "archive active set"),
      line("preset", "preset starred filters starred"),
    ];
    for (const verdict of safetyProperty(bad)) expect(verdict.length).toBeGreaterThan(0);
    for (const verdict of safetyProperty(good)) expect(verdict).toEqual([]);
    await assertGate(
      "safety.property composition",
      fc.property(fc.subarray(bad, { minLength: 1 }), fc.subarray(good), (broken, fine) => {
        const input: SafetyInput = {
          contributions: [...fine, ...broken].flatMap((item) => item.contributions),
        };
        const [verdict] = safetyProperty([input]);
        expect(verdict?.length).toBe(broken.length);
        // Stable: the same list in any order.
        const reversed: SafetyInput = { contributions: [...input.contributions].reverse() };
        expect(safetyProperty([reversed])[0]).toEqual(verdict);
        let thrown: unknown;
        try {
          verify(input);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(SafetyError);
        const error = thrown as SafetyError;
        expect(error.code).toBe("OKM1190");
        expect(error.violations).toEqual(verdict ?? []);
        expect(error.rule).toBe(verdict?.[0]?.rule ?? "");
        // No value in a violation: only rule names and contribution text.
        expect(JSON.stringify(error.violations).includes("secret")).toBe(false);
      }),
      80,
    );
  },
);
