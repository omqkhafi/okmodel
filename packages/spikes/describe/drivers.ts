/**
 * Describe probes for each Postgres adapter.
 *
 * Each probe reports parameter OIDs, column names, column type OIDs, and
 * table OID plus attnum without Bind or Execute when the driver allows it.
 * Throwaway spike code. Nothing here is imported from `src/`.
 */

import { PGlite } from "@electric-sql/pglite";
import { neonConfig, Pool } from "@neondatabase/serverless";
import pg from "pg";
import postgres from "postgres";

import { parseTarget } from "./protocol.js";
import { startBridge, type WsBridge } from "./ws-bridge.js";

/** Where a field comes from. */
export type DescribeRoute = "public" | "internal" | "not-possible" | "untested";

/** One described result column. Null table fields mean the API does not return them. */
export type ProbedColumn = {
  /** Result name. */
  readonly name: string;
  /** Column type OID, or null when the API does not return it. */
  readonly typeOid: number | null;
  /** Source table OID, or null when the API does not return it. */
  readonly tableOid: number | null;
  /** Source `attnum`, or null when the API does not return it. */
  readonly attnum: number | null;
};

/** One statement described by a driver. */
export type ProbedDescribe = {
  /** Parameter type OIDs in `$1` order. */
  readonly parameterOids: readonly number[];
  /** Result columns. Empty when the server sends NoData. */
  readonly columns: readonly ProbedColumn[];
};

/** A driver that can attempt describe. */
export type DriverSession = {
  /** Matrix row name. */
  readonly name: string;
  /** How parameter OIDs are obtained. */
  readonly parameterOids: DescribeRoute;
  /** How column names are obtained. */
  readonly columnNames: DescribeRoute;
  /** How column type OIDs are obtained. */
  readonly columnTypeOids: DescribeRoute;
  /** How table OID and attnum are obtained. */
  readonly tableOidAttnum: DescribeRoute;
  /** Why this route was chosen. The probe may append what it inspected. */
  note: string;
  /**
   * Opens the driver.
   *
   * @param url - Postgres URL. PGlite ignores it
   */
  open(url: string): Promise<void>;
  /**
   * Describes one statement without executing it.
   *
   * @param text - SQL text
   * @returns OIDs and columns
   */
  describe(text: string): Promise<ProbedDescribe>;
  /** Closes the driver. */
  close(): Promise<void>;
  /**
   * Runs SQL inside this session's database.
   *
   * PGlite is in-process, so setup cannot go through the TCP fixture
   * connection. Absent on TCP drivers.
   *
   * @param text - SQL, possibly several statements
   */
  apply?(text: string): Promise<void>;
  /**
   * Reads the first column of the first row. Executes the statement.
   *
   * @param text - One statement
   * @returns Cell text, or null
   */
  scalar?(text: string): Promise<string | null>;
};

type PgField = {
  readonly name: string;
  readonly tableID: number;
  readonly columnID: number;
  readonly dataTypeID: number;
};

type PgConn = {
  parse(query: { text: string; name: string; types: readonly number[] }): void;
  describe(msg: { type: "S"; name: string }): void;
  sync(): void;
  on(event: "parameterDescription", cb: (msg: { dataTypeIDs: number[] }) => void): void;
  removeListener(event: "parameterDescription", cb: (msg: { dataTypeIDs: number[] }) => void): void;
  on(event: "noData", cb: () => void): void;
  removeListener(event: "noData", cb: () => void): void;
};

type SubmitQuery = {
  text: string;
  callback: (err: Error | null) => void;
  handleRowDescription: (msg: { fields: readonly PgField[] }) => void;
  handleReadyForQuery: () => void;
  handleError: (err: Error) => void;
  submit: (connection: PgConn) => null;
};

/**
 * postgres.js `.describe()`. Public API. Works with `prepare: false` on the
 * connection because `.describe()` forces an unnamed Parse plus Describe.
 *
 * @returns A session
 */
export function postgresJsSession(): DriverSession {
  let sql: postgres.Sql | undefined;
  return {
    name: "postgres.js",
    parameterOids: "public",
    columnNames: "public",
    columnTypeOids: "public",
    tableOidAttnum: "public",
    note: "PendingQuery.describe() returns Statement.types and columns[].name, type, table, number. The okmodel adapter opens the pool with prepare false; this session does too.",
    async open(url) {
      sql = postgres(url, { max: 1, prepare: false });
      await sql`select 1`;
    },
    async describe(text) {
      const live = required(sql, "postgres.js");
      const described = await live.unsafe(text, [], { prepare: true }).describe();
      return {
        parameterOids: described.types,
        columns: described.columns.map((column) => ({
          name: column.name,
          typeOid: column.type,
          tableOid: column.table,
          attnum: column.number,
        })),
      };
    },
    async close() {
      await sql?.end();
    },
  };
}

type PgConnectable = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(query: SubmitQuery): void;
};

/**
 * node-postgres has no describe method. `Client.query` accepts an object with
 * `submit`, which is how `pg-cursor` sends protocol messages. This session
 * sends unnamed Parse, statement Describe, and Sync, and does not Bind.
 *
 * @returns A session
 */
export function nodePostgresSession(): DriverSession {
  let client: PgConnectable | undefined;
  return {
    name: "node-postgres",
    parameterOids: "internal",
    columnNames: "internal",
    columnTypeOids: "internal",
    tableOidAttnum: "internal",
    note: "No public describe. pg.Connection.parse, describe({ type: 'S' }), and sync are reached through the undocumented query submit hook. RowDescription fields include tableID and columnID. client.query() itself always Bind and Execute.",
    async open(url) {
      const Ctor = clientCtor();
      client = new Ctor({ connectionString: url });
      await client.connect();
    },
    describe(text) {
      const live = required(client, "node-postgres");
      return describeOnPgClient(live, text);
    },
    async close() {
      await client?.end();
    },
  };
}

/**
 * Bun.sql has no describe in its types. The session records the methods it
 * found and refuses to run the statement.
 *
 * @returns A session
 */
export function bunSqlSession(): DriverSession {
  let sql: InstanceType<typeof import("bun").SQL> | undefined;
  let found = "";
  return {
    name: "Bun.sql",
    parameterOids: "not-possible",
    columnNames: "not-possible",
    columnTypeOids: "not-possible",
    tableOidAttnum: "not-possible",
    note: "SQL.Query exposes cancel, simple, execute, raw, and values. There is no describe. Reserved connections expose the same query surface.",
    async open(url) {
      const { SQL } = await import("bun");
      sql = new SQL({ url, max: 1, prepare: false });
      await sql`select 1`;
      const query = sql`select 1`;
      const reserved = await sql.reserve();
      found = `query: ${methodNames(query).join(", ")}; reserved: ${methodNames(reserved).join(", ")}`;
      await Promise.resolve(reserved.release());
      this.note = `${this.note} Inspected methods: ${found}.`;
    },
    describe() {
      return Promise.reject(new Error(`Bun.sql cannot describe without executing (${found})`));
    },
    async close() {
      await sql?.close();
    },
  };
}

/**
 * PGlite `describeQuery` returns parameter and result type OIDs and names.
 * Table OID and attnum stay on the RowDescription that `execProtocol` returns.
 * Both are public.
 *
 * @returns A session
 */
export function pgliteSession(): DriverSession {
  let db: PGlite | undefined;
  return {
    name: "PGlite",
    parameterOids: "public",
    columnNames: "public",
    columnTypeOids: "public",
    tableOidAttnum: "public",
    note: "describeQuery drops table OID and attnum. protocol.serialize parse + describe + sync, passed to execProtocol, returns RowDescription fields with tableID and columnID. The bundled engine is one version.",
    async open() {
      db = new PGlite("memory://");
      await db.waitReady;
      const sample = await db.describeQuery("select 1 as n");
      const field = sample.resultFields[0];
      const keys = field === undefined ? "" : Object.keys(field).join(", ");
      this.note = `${this.note} describeQuery field keys: ${keys}.`;
    },
    async describe(text) {
      const live = required(db, "PGlite");
      return describeOnPglite(live, text);
    },
    async close() {
      await db?.close();
    },
    async apply(text) {
      const live = required(db, "PGlite");
      await live.exec(text);
    },
    async scalar(text) {
      const live = required(db, "PGlite");
      const result = await live.query<{ [key: string]: unknown }>(text);
      const row = result.rows[0];
      if (row === undefined) return null;
      const value = Object.values(row)[0];
      if (value === null || value === undefined) return null;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
      ) {
        return String(value);
      }
      return JSON.stringify(value);
    },
  };
}

/**
 * Neon WebSocket is node-postgres over a WebSocket. The same submit hook
 * describes. A local bridge copies bytes to TCP Postgres when the URL is not
 * a Neon host.
 *
 * @returns A session
 */
export function neonWebSocketSession(): DriverSession {
  let pool: Pool | undefined;
  let bridge: WsBridge | undefined;
  return {
    name: "Neon WebSocket",
    parameterOids: "internal",
    columnNames: "internal",
    columnTypeOids: "internal",
    tableOidAttnum: "internal",
    note: "No public describe. The WebSocket client subclasses node-postgres, so the same undocumented submit hook sends Parse, Describe, and Sync. This run reaches local Postgres through a byte-copying WebSocket bridge because NEON_URL is unset. Neon's own pooler was not in the path.",
    async open(url) {
      const target = parseTarget(url);
      bridge = startBridge(target.host, target.port);
      neonConfig.webSocketConstructor = WebSocket;
      neonConfig.useSecureWebSocket = false;
      neonConfig.forceDisablePgSSL = true;
      neonConfig.pipelineConnect = false;
      neonConfig.coalesceWrites = false;
      neonConfig.poolQueryViaFetch = false;
      const port = bridge.port;
      neonConfig.wsProxy = () => `127.0.0.1:${String(port)}`;
      pool = new Pool({ connectionString: url, max: 1 });
      const client = await pool.connect();
      client.release();
    },
    describe(text) {
      const live = required(pool, "Neon WebSocket");
      return describeOnNeonPool(live, text);
    },
    async close() {
      await pool?.end();
      bridge?.stop();
    },
  };
}

/**
 * Neon HTTP always POSTs the statement to `/sql`. There is no describe call
 * on the client. A live call needs `NEON_URL`.
 *
 * @returns A session that refuses when the URL is not set
 */
export function neonHttpSession(): DriverSession {
  const url = process.env.NEON_URL;
  return {
    name: "Neon HTTP",
    parameterOids: url === undefined || url.length === 0 ? "untested" : "not-possible",
    columnNames: url === undefined || url.length === 0 ? "untested" : "not-possible",
    columnTypeOids: url === undefined || url.length === 0 ? "untested" : "not-possible",
    tableOidAttnum: url === undefined || url.length === 0 ? "untested" : "not-possible",
    note:
      url === undefined || url.length === 0
        ? "untested: NEON_URL is unset. The HTTP client exports query, unsafe, and transaction, and every call POSTs the SQL to Neon's /sql endpoint. This run had no Neon host."
        : "The HTTP client has no describe method. A call with fullResults executes the statement.",
    open() {
      return Promise.resolve();
    },
    describe() {
      if (url === undefined || url.length === 0) {
        return Promise.reject(new Error("untested: NEON_URL is unset"));
      }
      return Promise.reject(new Error("Neon HTTP executes; it does not describe"));
    },
    close() {
      return Promise.resolve();
    },
  };
}

/**
 * Describes on a node-postgres client without Bind or Execute.
 *
 * @param client - Connected client
 * @param text - SQL text
 * @returns OIDs and columns
 */
function describeOnPgClient(client: PgConnectable, text: string): Promise<ProbedDescribe> {
  const run = client.query.bind(client) as (query: SubmitQuery) => void;
  return new Promise((resolve, reject) => {
    const columns: ProbedColumn[] = [];
    let parameterOids: readonly number[] = [];
    let settled = false;
    let connection: PgConn | undefined;
    const onParam = (msg: { dataTypeIDs: number[] }) => {
      parameterOids = msg.dataTypeIDs;
    };
    const finish = (error: Error | null) => {
      connection?.removeListener("parameterDescription", onParam);
      if (settled) return;
      settled = true;
      if (error !== null) reject(error);
      else resolve({ parameterOids, columns });
    };
    const query: SubmitQuery = {
      text,
      callback: finish,
      handleRowDescription(msg) {
        for (const field of msg.fields) {
          columns.push({
            name: field.name,
            typeOid: field.dataTypeID,
            tableOid: field.tableID,
            attnum: field.columnID,
          });
        }
      },
      handleReadyForQuery() {
        finish(null);
      },
      handleError(error) {
        finish(error);
      },
      submit(conn) {
        connection = conn;
        conn.on("parameterDescription", onParam);
        conn.parse({ text, name: "", types: [] });
        conn.describe({ type: "S", name: "" });
        conn.sync();
        return null;
      },
    };
    run(query);
  });
}

/**
 * Describes on a Neon pool client. Same protocol as node-postgres.
 *
 * @param pool - Connected WebSocket pool
 * @param text - SQL text
 * @returns OIDs and columns
 */
async function describeOnNeonPool(pool: Pool, text: string): Promise<ProbedDescribe> {
  const client = await pool.connect();
  try {
    return await describeOnPgClient(client as unknown as PgConnectable, text);
  } finally {
    client.release();
  }
}

type ProtocolSerialize = {
  parse(query: { text: string; types?: readonly number[] }): Uint8Array;
  describe(msg: { type: "S" | "P"; name?: string }): Uint8Array;
  sync(): Uint8Array;
};

type ProtocolField = {
  readonly name: string;
  readonly tableID?: number;
  readonly columnID?: number;
  readonly dataTypeID?: number;
};

type ProtocolMessage = {
  readonly name?: string;
  readonly dataTypeIDs?: readonly number[];
  readonly fields?: readonly ProtocolField[];
};

/**
 * Describes through PGlite's public protocol helpers.
 *
 * @param db - Open database
 * @param text - SQL text
 * @returns OIDs and columns, including table OID and attnum
 */
async function describeOnPglite(db: PGlite, text: string): Promise<ProbedDescribe> {
  const loaded = (await import("@electric-sql/pglite")) as {
    protocol?: { serialize: ProtocolSerialize };
  };
  const serialize = loaded.protocol?.serialize;
  if (serialize === undefined) throw new Error("PGlite protocol.serialize is missing");
  const bytes = concatBytes([
    serialize.parse({ text, types: [] }),
    serialize.describe({ type: "S" }),
    serialize.sync(),
  ]);
  const result = await db.execProtocol(bytes, { throwOnError: false });
  let parameterOids: readonly number[] = [];
  const columns: ProbedColumn[] = [];
  for (const message of result.messages as readonly ProtocolMessage[]) {
    if (message.name === "parameterDescription" && message.dataTypeIDs !== undefined) {
      parameterOids = message.dataTypeIDs;
    }
    if (message.name === "rowDescription" && message.fields !== undefined) {
      for (const field of message.fields) {
        columns.push({
          name: field.name,
          typeOid: field.dataTypeID ?? null,
          tableOid: field.tableID ?? null,
          attnum: field.columnID ?? null,
        });
      }
    }
    if (message.name === "error") {
      const error = message as { code?: string; message?: string };
      const wrapped = new Error(error.message ?? "PGlite describe failed") as Error & {
        code?: string;
      };
      if (error.code !== undefined) wrapped.code = error.code;
      throw wrapped;
    }
  }
  return { parameterOids, columns };
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function methodNames(value: object): readonly string[] {
  const names = new Set<string>();
  let current: object | null = value;
  while (current !== null && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key !== "constructor") names.add(key);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names].sort();
}

/**
 * `pg` ships a `Client` at runtime. The local declaration file only names `Pool`.
 *
 * @returns The `pg.Client` constructor
 */
function clientCtor(): new (config: { connectionString: string }) => PgConnectable {
  const bag = pg as unknown as {
    Client?: new (config: { connectionString: string }) => PgConnectable;
  };
  if (bag.Client === undefined) throw new Error("pg.Client is missing");
  return bag.Client;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not open`);
  return value;
}
