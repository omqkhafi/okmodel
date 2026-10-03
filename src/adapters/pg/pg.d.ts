/**
 * The slice of node-postgres this adapter uses.
 *
 * `pg` ships no types. This declaration stays inside the adapter.
 */

declare module "pg" {
  /** Pool options this adapter sets. */
  interface PoolConfig {
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    allowExitOnIdle?: boolean;
    application_name?: string;
    ssl?: boolean | "require" | "allow" | "prefer" | "verify-full" | object;
    options?: string;
    types?: TypeParsers;
  }

  /** Identity parsers. Values stay wire text. */
  interface TypeParsers {
    getTypeParser(oid: number, format?: string): (value: string) => string;
  }

  /** One query. `rowMode: "array"` returns rows as arrays. */
  interface QueryConfig {
    text: string;
    values?: readonly unknown[];
    rowMode?: "array";
    types?: TypeParsers;
    /** Named prepared statement. Omitted uses the unnamed protocol. */
    name?: string;
  }

  /** A result. `rows` are arrays when `rowMode` is `"array"`. */
  interface QueryResult {
    rows: unknown[][];
    rowCount: number | null;
  }

  /** A server notice. */
  interface NoticeMessage {
    severity?: string;
    code?: string;
    message?: string;
  }

  /** A notification. */
  interface Notification {
    channel: string;
    payload?: string;
  }

  /** One checked-out client. */
  interface PoolClient {
    processID: number | null;
    secretKey: number | null;
    host: string;
    port: number;
    query(config: QueryConfig): Promise<QueryResult>;
    query(text: string): Promise<QueryResult>;
    release(err?: Error | boolean): void;
    on(event: "notice", listener: (notice: NoticeMessage) => void): void;
    on(event: "notification", listener: (message: Notification) => void): void;
    removeListener(event: "notification", listener: (message: Notification) => void): void;
  }

  /** A connection pool. */
  class Pool {
    constructor(config?: PoolConfig);
    query(config: QueryConfig): Promise<QueryResult>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: "connect", listener: (client: PoolClient) => void): void;
  }

  /** The package default. Adapters use {@link Pool}. */
  const pg: {
    Pool: typeof Pool;
  };

  export default pg;
  export type { NoticeMessage, Notification, PoolClient, PoolConfig, QueryConfig, QueryResult };
}
