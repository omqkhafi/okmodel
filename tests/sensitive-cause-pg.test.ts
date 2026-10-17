/**
 * Sensitive values stay out of error.cause on every adapter (B-33).
 *
 * Unique, foreign-key, and check violations. Asserts message, String, JSON,
 * cause own keys, util.inspect, otel spans, and logger output.
 */

import { expect, test } from "bun:test";
import { inspect } from "node:util";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, sql, table, text, uuid } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { otel, type OtelAttribute, type OtelSpan, type OtelTracer } from "../src/runtime/otel.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import type { Connected } from "../src/runtime/types.js";

const SECRET = "TOPSECRET-123";
const PARENT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d01";
const CHILD = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d02";
const OTHER = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d03";

const parents = table("parents", {
  id: id({ default: "none" }),
  label: text(),
});

const secrets = table(
  "secrets",
  {
    id: id({ default: "none" }),
    secret: text().sensitive().unique(),
    parentId: uuid().references("parents").nullable(),
  },
  {
    checks: {
      secretOk: (columns) => sql`${columns.secret} <> 'bad-check-value'`,
    },
  },
);

const plain = table("plain", {
  id: id({ default: "none" }),
  email: text().unique(),
});

const app = schema({ casing: "snake", tables: [parents, secrets, plain] });
const gate = await loadPostgresGate();

type Db = Connected<typeof app>;

type Seen = {
  readonly name: string;
  readonly attributes: Record<string, OtelAttribute>;
  recorded:
    | {
        readonly name?: string;
        readonly code?: string;
        readonly message?: string;
        readonly stack?: string;
      }
    | undefined;
  readonly events: { readonly name: string; readonly attributes: Record<string, OtelAttribute> }[];
};

function recorder(): {
  readonly spans: Seen[];
  readonly tracer: OtelTracer;
  readonly logs: string[];
} {
  const spans: Seen[] = [];
  const logs: string[] = [];
  const tracer: OtelTracer = {
    startSpan(name, options) {
      const span: Seen = {
        name,
        attributes: { ...options?.attributes },
        recorded: undefined,
        events: [],
      };
      spans.push(span);
      const handle: OtelSpan = {
        setAttribute(key, value) {
          span.attributes[key] = value;
        },
        setStatus() {},
        addEvent(event, attributes) {
          span.events.push({ name: event, attributes: { ...attributes } });
        },
        recordException(exception) {
          span.recorded = { ...exception };
        },
        end() {},
      };
      return handle;
    },
  };
  return { spans, tracer, logs };
}

function leakNowhere(
  error: OkmError,
  value: string,
  spans: readonly Seen[],
  logs: readonly string[],
): void {
  expect(error.message.includes(value)).toBe(false);
  expect(String(error).includes(value)).toBe(false);
  expect(JSON.stringify(error).includes(value)).toBe(false);
  expect(inspect(error, { depth: 10 }).includes(value)).toBe(false);
  const cause = error.cause;
  if (cause !== undefined && cause !== null) {
    expect(inspect(cause, { depth: 10 }).includes(value)).toBe(false);
    expect(JSON.stringify(cause).includes(value)).toBe(false);
    if (typeof cause === "object") {
      for (const key of Reflect.ownKeys(cause)) {
        const held = Reflect.get(cause, key);
        if (typeof held === "string") expect(held.includes(value)).toBe(false);
        else expect(inspect(held, { depth: 10 }).includes(value)).toBe(false);
      }
    }
  }
  expect(JSON.stringify(spans).includes(value)).toBe(false);
  expect(inspect(spans, { depth: 10 }).includes(value)).toBe(false);
  expect(logs.join("\n").includes(value)).toBe(false);
}

async function openDriver(
  driver: "postgresjs" | "pg" | "bun" | "pglite",
  schemaName: string | undefined,
  tracing: ReturnType<typeof recorder>,
  observers: ReturnType<typeof otel>,
): Promise<{ readonly db: Db; readonly close: () => Promise<void> }> {
  const logger = {
    error(entry: { readonly code?: string; readonly summary?: string }) {
      tracing.logs.push(`${entry.code ?? ""} ${entry.summary ?? ""}`);
    },
  };
  if (driver === "pglite") {
    const pool = await openPglite();
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connectPglite(pool, {
      schema: app,
      hookm: [observers.hookm],
      logger,
    });
    return {
      db,
      close: async () => {
        await db.close();
        await pool.close();
      },
    };
  }
  const url = primaryUrl();
  const path = schemaName ?? "public";
  if (driver === "postgresjs") {
    const db = connectPostgres(openPostgres({ url, searchPath: path, max: 1 }), {
      schema: app,
      hookm: [observers.hookm],
      logger,
    });
    return { db, close: () => db.close() };
  }
  if (driver === "pg") {
    const db = connectPg(openPg({ url, searchPath: path, max: 1 }), {
      schema: app,
      hookm: [observers.hookm],
      logger,
    });
    return { db, close: () => db.close() };
  }
  const db = connectBun(openBun({ url, searchPath: path, max: 1 }), {
    schema: app,
    hookm: [observers.hookm],
    logger,
  });
  return { db, close: () => db.close() };
}

async function checkSensitive(
  db: Db,
  tracing: ReturnType<typeof recorder>,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  await db.parents.insert({ id: PARENT, label: "p" });
  await db.secrets.insert({ id: CHILD, secret: SECRET, parentId: PARENT });

  const unique = await db.secrets.insert({ id: OTHER, secret: SECRET, parentId: PARENT }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(unique).toBeInstanceOf(OkmError);
  if (unique instanceof OkmError) {
    expect(unique.kind).toBe("unique");
    onError?.(unique);
    leakNowhere(unique, SECRET, tracing.spans, tracing.logs);
    expect(unique.cause).not.toHaveProperty("detail");
  }

  tracing.spans.length = 0;
  tracing.logs.length = 0;
  const missing = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d99";
  const fk = await db.secrets.insert({ id: OTHER, secret: "other-secret", parentId: missing }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(fk).toBeInstanceOf(OkmError);
  if (fk instanceof OkmError) {
    expect(fk.kind).toBe("foreign_key");
    onError?.(fk);
    leakNowhere(fk, "other-secret", tracing.spans, tracing.logs);
    leakNowhere(fk, missing, tracing.spans, tracing.logs);
  }

  tracing.spans.length = 0;
  tracing.logs.length = 0;
  const bad = await db.secrets
    .insert({ id: OTHER, secret: "bad-check-value", parentId: PARENT })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(bad).toBeInstanceOf(OkmError);
  if (bad instanceof OkmError) {
    expect(bad.kind).toBe("check");
    onError?.(bad);
    leakNowhere(bad, "bad-check-value", tracing.spans, tracing.logs);
  }

  await db.plain.insert({ id: PARENT, email: "ada@example.com" });
  const plainErr = await db.plain.insert({ id: OTHER, email: "ada@example.com" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(plainErr).toBeInstanceOf(OkmError);
  if (plainErr instanceof OkmError) {
    expect(plainErr.kind).toBe("unique");
    expect(plainErr.message.includes("ada@example.com")).toBe(false);
    expect(inspect(plainErr.cause, { depth: 10 })).toContain("ada@example.com");
  }
}

test("pglite: B-33 sensitive cause redaction", async () => {
  const tracing = recorder();
  const observers = otel({ tracer: tracing.tracer });
  const { db, close } = await openDriver("pglite", undefined, tracing, observers);
  try {
    await db.connected;
    await checkSensitive(db, tracing, (error) => observers.hookm.onError?.(error));
  } finally {
    await close();
  }
}, 30_000);

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  postgresTest(
    gate,
    `${driver}: B-33 sensitive cause redaction`,
    async () => {
      await withPostgresSchema(async (sql, schemaName) => {
        for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
        const tracing = recorder();
        const observers = otel({ tracer: tracing.tracer });
        const { db, close } = await openDriver(driver, schemaName, tracing, observers);
        try {
          await db.connected;
          await checkSensitive(db, tracing, (error) => observers.hookm.onError?.(error));
        } finally {
          await close();
        }
      });
    },
    60_000,
  );
}
