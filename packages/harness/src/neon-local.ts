/**
 * A local Neon endpoint for tests: HTTP `/sql` and WebSocket `/v2`.
 *
 * The client stays the real `@neondatabase/serverless` driver, so its own
 * type parsing runs. The WebSocket side copies bytes to TCP Postgres. `/sql`
 * runs each statement on node-postgres and answers in the shape Neon's proxy
 * sends for `Neon-Raw-Text-Output: true`: wire text plus each field's type OID.
 * This is not Neon's proxy. It does not check auth, isolation headers, or the
 * connection string.
 */

import { connect as connectTcp, type Socket } from "node:net";

import { neonConfig } from "@neondatabase/serverless";
import pg, { type PoolClient } from "pg";

/** A running local endpoint. */
export type NeonLocal = {
  /** URL to pass to the Neon adapter. The host is never resolved. */
  readonly url: string;
  /** `127.0.0.1:<port>`, for a client in another process such as workerd. */
  readonly host: string;
  /** Stops the server, its sockets, and its Postgres pool. */
  close(): Promise<void>;
};

type SocketData = { socket?: Socket };

/** Result fields node-postgres sets that its slice in `pg.d.ts` leaves out. */
type Field = {
  name: string;
  dataTypeID: number;
  tableID: number;
  columnID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
};

type Statement = { query: string; params?: readonly (string | null)[] };

const RAW = { getTypeParser: () => (value: string) => value };

/** Fields the driver copies from a 400 body onto its error. */
const ERROR_FIELDS = [
  "severity",
  "code",
  "detail",
  "hint",
  "position",
  "schema",
  "table",
  "column",
  "dataType",
  "constraint",
  "where",
] as const;

/**
 * Starts the endpoint and points `neonConfig` at it.
 *
 * @param postgresUrl - TCP Postgres the endpoint forwards to
 * @returns The endpoint
 */
export function startNeonLocal(postgresUrl: string): NeonLocal {
  const target = new URL(postgresUrl);
  const pool = new pg.Pool({ connectionString: postgresUrl, max: 4 });
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bun) {
      if (new URL(request.url).pathname === "/sql") return sql(pool, request);
      return bun.upgrade(request, { data: {} })
        ? undefined
        : new Response("websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        const socket = connectTcp(Number(target.port), target.hostname);
        ws.data.socket = socket;
        socket.on("data", (chunk: Buffer) => ws.send(chunk));
        socket.on("close", () => ws.close());
        socket.on("error", () => ws.close());
      },
      message(ws, message) {
        ws.data.socket?.write(typeof message === "string" ? Buffer.from(message) : message);
      },
      close(ws) {
        ws.data.socket?.end();
      },
    },
  });
  const port = server.port ?? 0;
  neonConfig.fetchEndpoint = () => `http://127.0.0.1:${String(port)}/sql`;
  neonConfig.wsProxy = () => `127.0.0.1:${String(port)}/v2`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
  return {
    host: `127.0.0.1:${String(port)}`,
    url: `postgres://${target.username}:${target.password}@neon.local${target.pathname}`,
    async close() {
      await server.stop(true);
      await pool.end();
    },
  };
}

async function sql(pool: InstanceType<typeof pg.Pool>, request: Request): Promise<Response> {
  const body = (await request.json()) as Statement | { queries: readonly Statement[] };
  const client = await pool.connect();
  try {
    if (!("queries" in body)) return Response.json(await run(client, body));
    await client.query("begin");
    try {
      const results = [];
      for (const statement of body.queries) results.push(await run(client, statement));
      await client.query("commit");
      return Response.json({ results });
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } catch (error) {
    return Response.json(errorBody(error), { status: 400 });
  } finally {
    client.release();
  }
}

async function run(client: PoolClient, statement: Statement): Promise<unknown> {
  const result = (await client.query({
    text: statement.query,
    values: statement.params === undefined ? [] : [...statement.params],
    rowMode: "array",
    types: RAW,
  })) as Awaited<ReturnType<PoolClient["query"]>> & { command: string; fields: Field[] };
  return {
    command: result.command,
    rowCount: result.rowCount,
    rowAsArray: true,
    rows: result.rows,
    fields: result.fields.map((field) => ({
      name: field.name,
      dataTypeID: field.dataTypeID,
      tableID: field.tableID,
      columnID: field.columnID,
      dataTypeSize: field.dataTypeSize,
      dataTypeModifier: field.dataTypeModifier,
      format: "text",
    })),
  };
}

function errorBody(error: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error === "object" && error !== null) {
    for (const name of ERROR_FIELDS) body[name] = Reflect.get(error, name);
  }
  return body;
}
