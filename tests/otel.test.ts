/**
 * `okmodel/otel` maps the existing observers onto a tracer.
 *
 * PGlite stands in for Postgres. The tracer is in memory. No collector.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import {
  otel,
  type OtelAttribute,
  type OtelObservers,
  type OtelSpan,
  type OtelTracer,
} from "../src/runtime/otel.js";
import { connectTopology, type RoutedClient } from "../src/runtime/topology.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

const SECRET = "secret-param";

type Seen = {
  readonly name: string;
  readonly kind: number | undefined;
  readonly attributes: Record<string, OtelAttribute>;
  status: number | undefined;
  readonly events: { readonly name: string; readonly attributes: Record<string, OtelAttribute> }[];
  exception: boolean;
  ended: boolean;
};

test("a read records the route and the fingerprint, not the parameter", async () => {
  const seen = recorder();
  const tracing = otel({ tracer: seen.tracer });
  const db = await openDb(tracing);
  try {
    await db.connected;
    seen.spans.length = 0;
    const pending = db.notes.find({ where: { title: SECRET }, limit: 1 });
    const inspection = await Promise.resolve(pending.inspect());
    tracing.query(inspection);
    expect(await Promise.resolve(pending)).toEqual([]);

    const route = seen.spans.find((span) => span.name === "read");
    expect(route?.kind).toBe(2);
    expect(route?.ended).toBe(true);
    expect(route?.attributes["db.system.name"]).toBe("postgresql");
    expect(route?.attributes["db.operation.name"]).toBe("read");
    expect(route?.attributes["db.query.text"]).toBeUndefined();
    expect(route?.attributes["db.query.summary"]).toBeUndefined();

    const query = seen.spans.find((span) => span.name === "find notes");
    expect(query?.attributes["db.system.name"]).toBe("postgresql");
    expect(query?.attributes["db.operation.name"]).toBe("find");
    expect(query?.attributes["db.collection.name"]).toBe("notes");
    expect(query?.attributes["db.query.summary"]).toBe(inspection.plan.fingerprint);
    expect(query?.attributes["db.query.summary"]).toMatch(/^Q_[0-9a-f]{16}$/);
    expect(query?.attributes["db.query.text"]).toBeUndefined();
    expect(mentioned(seen.spans)).not.toContain(SECRET);
  } finally {
    await db.close();
  }
}, 15_000);

test("statement text is opt-in and parameters stay off", async () => {
  const seen = recorder();
  const tracing = otel({ tracer: seen.tracer, statement: true });
  const db = await openDb(tracing);
  try {
    await db.connected;
    const pending = db.notes.find({ where: { title: SECRET }, limit: 1 });
    const inspection = await Promise.resolve(pending.inspect());
    tracing.query(inspection);
    const query = seen.spans.find((span) => span.name === "find notes");
    expect(query?.attributes["db.query.text"]).toBe(inspection.sql.text);
    expect(String(query?.attributes["db.query.text"])).not.toContain(SECRET);
    expect(mentioned(seen.spans)).not.toContain(SECRET);
    expect(inspection.sql.params).toContain(SECRET);
  } finally {
    await db.close();
  }
}, 15_000);

test("a write is a write span", async () => {
  const seen = recorder();
  const tracing = otel({ tracer: seen.tracer });
  const db = await openDb(tracing);
  try {
    await db.connected;
    seen.spans.length = 0;
    await Promise.resolve(db.notes.insert({ id: "n1", title: "a" }));
    const write = seen.spans.find((span) => span.name === "write");
    expect(write?.attributes["db.operation.name"]).toBe("write");
    expect(write?.attributes["db.system.name"]).toBe("postgresql");
    expect(write?.ended).toBe(true);
    expect(write?.events[0]).toEqual({
      name: "route",
      attributes: { endpoint: "primary", reason: "primary-required" },
    });
  } finally {
    await db.close();
  }
}, 15_000);

test("an afterCommit error is an error span", async () => {
  const seen = recorder();
  const tracing = otel({ tracer: seen.tracer });
  const db = await openDb(tracing);
  try {
    await db.connected;
    seen.spans.length = 0;
    await db.tx(async (tx) => {
      tx.afterCommit(() => {
        throw new Error("after");
      });
    });
    const error = seen.spans.find((span) => span.name === "error");
    expect(error?.attributes["error.type"]).toBe("Error");
    expect(error?.attributes["db.system.name"]).toBe("postgresql");
    expect(error?.status).toBe(2);
    expect(error?.exception).toBe(true);
    expect(error?.ended).toBe(true);
    expect(mentioned(seen.spans).join(" ")).not.toContain("after");
  } finally {
    await db.close();
  }
}, 15_000);

test("a transaction span ends when the transaction commits", async () => {
  const seen = recorder();
  const tracing = otel({ tracer: seen.tracer });
  const db = await openDb(tracing);
  try {
    await db.connected;
    seen.spans.length = 0;
    await db.tx(async (tx) => {
      await tx.notes.insert({ id: "n1", title: "a" });
    });
    const tx = seen.spans.find((span) => span.name === "transaction");
    expect(tx?.attributes["db.operation.name"]).toBe("transaction");
    expect(tx?.attributes["db.system.name"]).toBe("postgresql");
    expect(tx?.status).toBe(1);
    expect(tx?.ended).toBe(true);
  } finally {
    await db.close();
  }
}, 15_000);

test("a routed read names the replica", async () => {
  const seen = recorder();
  const tracing = otel({ tracer: seen.tracer });
  const db = await openDb(tracing);
  try {
    await db.connected;
    seen.spans.length = 0;
    expect(await Promise.resolve(db.notes.find({ limit: 1 }))).toEqual([]);
    const read = seen.spans.find((span) => span.name === "read");
    expect(read?.attributes["db.operation.name"]).toBe("read");
    expect(read?.events.at(-1)).toEqual({
      name: "route",
      attributes: { endpoint: "east", reason: "auto:east" },
    });
  } finally {
    await db.close();
  }
}, 15_000);

/**
 * Records spans from one tracer.
 */
function recorder(): { readonly tracer: OtelTracer; readonly spans: Seen[] } {
  const spans: Seen[] = [];
  const tracer: OtelTracer = {
    startSpan(name, options) {
      const seen: Seen = {
        name,
        kind: options?.kind,
        attributes: { ...options?.attributes },
        status: undefined,
        events: [],
        exception: false,
        ended: false,
      };
      spans.push(seen);
      const span: OtelSpan = {
        setAttribute(key, value) {
          seen.attributes[key] = value;
        },
        setStatus(status) {
          seen.status = status.code;
        },
        recordException() {
          seen.exception = true;
        },
        addEvent(eventName, attributes) {
          seen.events.push({ name: eventName, attributes: { ...attributes } });
        },
        end() {
          seen.ended = true;
        },
      };
      return span;
    },
  };
  return { tracer, spans };
}

/**
 * Every attribute value the tracer saw.
 *
 * @param spans - Recorded spans
 */
function mentioned(spans: readonly Seen[]): readonly string[] {
  const values: string[] = [];
  for (const span of spans) {
    for (const value of Object.values(span.attributes)) values.push(String(value));
    for (const event of span.events) {
      for (const value of Object.values(event.attributes)) values.push(String(value));
    }
  }
  return values;
}

/**
 * Opens a primary and one caught-up replica.
 *
 * @param tracing - Observers under test
 */
async function openDb(tracing: OtelObservers): Promise<RoutedClient<typeof app>> {
  const catalog = (app as typeof app & { readonly catalog: Catalog }).catalog;
  return connectTopology(
    { primary: memory("primary"), replicas: [{ url: memory("east"), name: "east" }] },
    {
      schema: app,
      routing: { probe: 60_000 },
      replicaState: { replayLsn: () => "0/1" },
      hookm: [tracing.hookm],
      onRoute: tracing.onRoute,
    },
    async (config) => {
      const pool = await open({ dataDir: config.dataDir });
      for (const statement of renderCatalog(catalog, "public")) await pool.execute(statement);
      return pool;
    },
  );
}

/**
 * A unique in-memory database. The label is the part before the first dash.
 *
 * @param label - Endpoint label
 */
function memory(label: string): string {
  return `memory://${label}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
