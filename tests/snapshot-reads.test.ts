/**
 * OKM1191 in 0.2: every read is one statement, so READ COMMITTED has a plan.
 *
 * The spec says a multi-statement read runs in one snapshot. Inside READ COMMITTED
 * the planner falls back to a single statement, or the call fails with OKM1191 when
 * none exists. In 0.2 an include, a relation, `page` and `aggregate` are all part of
 * one `SELECT` (lateral joins and subqueries), so the single-statement plan always
 * exists and OKM1191 has nothing to refuse. This test shows both halves on real
 * Postgres: the statement count inside `tx({ isolation: "read committed" })`, and
 * that a reader never sees half of a committed pair while a writer commits pairs.
 * If a read ever needs a second statement, the first half fails and the author must
 * make the call throw OKM1191 instead.
 */

import { expect } from "bun:test";

import { has, none } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withGate, type GateEnv } from "./gate-env.js";
import { key, TENANT_A } from "./gate-schema.js";

const gate = await loadPostgresGate();

/** `any` is justified: the test calls the runtime surface by table name, as an application does. */
// oxlint-disable-next-line typescript/no-explicit-any
type Loose = { readonly [table: string]: any };

/** Statements that carry the read, not the transaction around it. */
const control = /^(begin|commit|rollback|savepoint|release|set |select set_config|reset)/i;

const scoped = (env: GateEnv): Loose => env.db.for({ tenantId: TENANT_A }) as unknown as Loose;

postgresTest(
  gate,
  "inside READ COMMITTED every read shape is one statement",
  async () => {
    await withGate({ max: 1 }, async (env) => {
      const db = scoped(env);
      await db.orgs.insert({ id: key("o", 0), name: "o0" });
      await db.projects.insert([
        { id: key("p", 0), orgId: key("o", 0), name: "p0" },
        { id: key("p", 1), orgId: key("o", 0), name: "p1" },
      ]);
      await db.tasks.insert([
        { id: key("t", 0), projectId: key("p", 0), title: "t0" },
        { id: key("t", 1), projectId: key("p", 0), title: "t1" },
        { id: key("t", 2), projectId: key("p", 1), title: "t2" },
      ]);
      await db.labels.insert({ id: key("l", 0), name: "l0" });
      await db.projectLabels.insert({
        id: key("j", 0),
        projectId: key("p", 0),
        labelId: key("l", 0),
      });
      const shapes: [string, (t: Loose) => PromiseLike<unknown>][] = [
        ["find", (t) => t.projects.find({ limit: 10 })],
        ["one", (t) => t.projects.one({ where: { id: key("p", 0) } })],
        ["count", (t) => t.projects.count()],
        ["exists", (t) => t.projects.exists({ where: { name: "p0" } })],
        ["include one", (t) => t.tasks.find({ include: { project: true }, limit: 10 })],
        ["include many", (t) => t.projects.find({ include: { tasks: { limit: 5 } }, limit: 10 })],
        [
          "include nested",
          (t) =>
            t.orgs.find({
              include: { projects: { limit: 5, include: { tasks: { limit: 5 } } } },
              limit: 10,
            }),
        ],
        [
          "include manyThrough",
          (t) => t.projects.find({ include: { labels: { limit: 5 } }, limit: 10 }),
        ],
        [
          "filter has manyThrough",
          (t) => t.projects.find({ where: { labels: has({ name: "l0" }) }, limit: 10 }),
        ],
        [
          "filter none manyThrough",
          (t) => t.projects.find({ where: { labels: none({ name: "l0" }) }, limit: 10 }),
        ],
        ["page", (t) => t.projects.page({ orderBy: { name: "asc" }, limit: 1 })],
        ["aggregate", (t) => t.tasks.aggregate({ groupBy: ["projectId"], count: true, limit: 10 })],
        [
          "aggregate sum",
          (t) => t.projects.aggregate({ sum: ["budget"], avg: ["budget"], count: true }),
        ],
      ];
      for (const [name, run] of shapes) {
        env.drain();
        const result = await db.tx({ isolation: "read committed" }, async (t: Loose) => {
          env.drain();
          const out = await run(t);
          return { out, sent: env.rec.log.map((statement) => statement.text) };
        });
        const reads = result.sent.filter((text: string) => !control.test(text));
        expect(reads, `${name}: ${reads.join(" ;; ")}`).toHaveLength(1);
        expect(result.out, name).toBeDefined();
      }
      // The transaction really was READ COMMITTED.
      env.drain();
      await db.tx({ isolation: "read committed" }, async (t: Loose) => t.projects.count());
      expect(env.rec.log.some((statement) => /read committed/i.test(statement.text))).toBe(true);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "inside READ COMMITTED a reader never sees half of a committed write",
  async () => {
    await withGate({ max: 3 }, async (env) => {
      const db = scoped(env);
      await db.orgs.insert({ id: key("o", 0), name: "o0" });
      const pairs = 80;
      // The writer commits a project with exactly two tasks, in one transaction.
      const writer = (async () => {
        for (let n = 0; n < pairs; n += 1) {
          await db.tx(async (t: Loose) => {
            await t.projects.insert({ id: key("p", n), orgId: key("o", 0), name: `p${String(n)}` });
            await t.tasks.insert([
              { id: key("t", n * 2), projectId: key("p", n), title: `t${String(n)}a` },
              { id: key("t", n * 2 + 1), projectId: key("p", n), title: `t${String(n)}b` },
            ]);
          });
        }
      })();
      let reads = 0;
      let writing = true;
      const seenProjects = new Set<number>();
      const bad: string[] = [];
      const reader = (async () => {
        while (writing || reads < 20) {
          await db.tx({ isolation: "read committed" }, async (t: Loose) => {
            const rows = (await t.projects.find({
              include: { tasks: { limit: 10 } },
              limit: 500,
            })) as { name: string; tasks: unknown[] }[];
            for (const row of rows) {
              if (row.tasks.length !== 2) bad.push(`${row.name}:${String(row.tasks.length)}`);
            }
            // One statement, one snapshot: the tasks counted per project agree with the include.
            const grouped = (await t.tasks.aggregate({
              groupBy: ["projectId"],
              count: true,
              limit: 500,
            })) as { count: number }[];
            for (const group of grouped)
              if (group.count !== 2) bad.push(`group:${String(group.count)}`);
            seenProjects.add(rows.length);
          });
          reads += 1;
        }
      })();
      await Promise.all([
        writer.finally(() => {
          writing = false;
        }),
        reader,
      ]);
      expect(bad).toEqual([]);
      // The reader ran while the writer was still committing, not only before or after.
      expect(seenProjects.size).toBeGreaterThan(2);
    });
  },
  120_000,
);
