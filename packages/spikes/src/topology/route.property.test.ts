/**
 * Primary-required operations executed on the streaming topology.
 *
 * The decision property is in `route.logic.test.ts`. This one checks that the
 * SQL actually runs on the primary.
 */

import { expect } from "bun:test";
import fc from "fast-check";

import { isolatedSchemaName, primaryUrl, replicaUrl } from "@okmodel/harness";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { connectTopology } from "./client.js";
import { TopologyError } from "./error.js";
import type { StatementEvent } from "./pool.js";
import type { OperationKind } from "./types.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const KINDS = ["write", "batch", "locking-read", "advisory-lock", "tx"] as const;

postgresTest(
  decision,
  "routing.property: no primary-required operation reaches a replica",
  async () => {
    const schema = isolatedSchemaName();
    const log: StatementEvent[] = [];
    const client = await connectTopology({
      primary: primaryUrl(),
      replicas: [
        { url: replicaUrl("a"), name: "a" },
        { url: replicaUrl("b"), name: "b" },
      ],
      routing: { select: "roundRobin", probe: "0ms" },
      onStatement: (event) => {
        log.push(event);
      },
    });
    try {
      await client.write(`CREATE SCHEMA ${schema}`);
      await client.write(`CREATE TABLE ${schema}.tick (id int primary key)`);
      await client.write(`INSERT INTO ${schema}.tick VALUES (1)`);
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...KINDS),
          fc.constantFrom("auto", "primary", "replica"),
          async (kind, constraint) => {
            const token = `p08a-prop-${crypto.randomUUID()}`;
            const before = log.length;
            const request = {
              kind: kind as OperationKind,
              statements: [{ text: statement(kind, schema, token) }],
              constraint:
                constraint === "auto"
                  ? { kind: "auto" as const }
                  : constraint === "primary"
                    ? { kind: "primary" as const }
                    : { kind: "replica" as const },
            };
            if (constraint === "replica") {
              const error = await rejection(client.run(request));
              expect(error).toBeInstanceOf(TopologyError);
              expect(log.slice(before).some((event) => event.text.includes(token))).toBe(false);
              return;
            }
            const result = await client.run(request);
            expect(result.decision.role).toBe("primary");
            expect(result.decision.endpoint).toBe("primary");
            expect(result.results[0]?.rows[0]?.[0]).toBe("false");
            const hits = log.slice(before).filter((event) => event.text.includes(token));
            expect(hits.length).toBeGreaterThan(0);
            expect(hits.every((event) => event.endpoint === "primary")).toBe(true);
          },
        ),
        { numRuns: 12 },
      );
    } finally {
      await client.write(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await client.close();
    }
  },
  60_000,
);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function statement(kind: (typeof KINDS)[number], schema: string, token: string): string {
  if (kind === "locking-read") {
    return `SELECT pg_is_in_recovery()::text /*${token}*/ FROM ${schema}.tick WHERE id = 1 FOR UPDATE`;
  }
  if (kind === "advisory-lock") {
    const key = Math.floor(Math.random() * 1_000_000_000) + 1;
    return `SELECT pg_is_in_recovery()::text /*${token}*/, pg_advisory_xact_lock(${String(key)})`;
  }
  return `SELECT pg_is_in_recovery()::text /*${token}*/`;
}
