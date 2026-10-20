/**
 * Minimal extended-protocol client for a tooling describe.
 *
 * One direct TCP connection. Startup, then unnamed Parse, Describe of that
 * statement, and Sync. No Bind, no Execute, no pool, no dependency beyond
 * `node:net` and `node:crypto`. Throwaway: this file is the size sample for
 * the F7a spike and is not imported from `src/`.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";

/** One result column from RowDescription. */
export type DescribeColumn = {
  /** Result name. */
  readonly name: string;
  /** Source table OID. Zero when the column is not a simple column reference. */
  readonly tableOid: number;
  /** `pg_attribute.attnum`. Zero when `tableOid` is zero. */
  readonly attnum: number;
  /** Column type OID. */
  readonly typeOid: number;
  /** Type modifier. `-1` when none. */
  readonly typeMod: number;
};

/** Parameter OIDs and result columns, or the server error from Parse/Describe. */
export type DescribeOutcome = {
  /** Parameter type OIDs, in `$1` order. Empty when the statement has none. */
  readonly parameterOids: readonly number[];
  /** Result columns. Empty when the server sends NoData. */
  readonly columns: readonly DescribeColumn[];
  /** SQLSTATE when Parse or Describe failed. Absent on success. */
  readonly code?: string;
  /** Primary error message when Parse or Describe failed. */
  readonly message?: string;
};

/** Connection target parsed from a `postgres://` URL. */
export type DescribeTarget = {
  /** Host. */
  readonly host: string;
  /** Port. */
  readonly port: number;
  /** Database user. */
  readonly user: string;
  /** Password. Empty when the URL has none. */
  readonly password: string;
  /** Database name. */
  readonly database: string;
};

type Backend = {
  readonly tag: number;
  readonly body: Buffer;
};

const READY = 90;
const ERROR = 69;
const AUTH = 82;
const PARAM = 116;
const ROW = 84;

/**
 * Opens one connection and describes statements until `close`.
 *
 * @param url - `postgres://` URL. SSL is not negotiated
 * @returns A client on a ready session
 */
export function connectDescribe(url: string): Promise<DescribeClient> {
  const target = parseTarget(url);
  const socket = connectTcp({ host: target.host, port: target.port });
  const client = new DescribeClient(socket, target);
  return client.open();
}

/**
 * One non-pooled session.
 *
 * Describe sends an unnamed Parse, a statement Describe, and Sync, then reads
 * until ReadyForQuery. The statement is not bound and not executed.
 */
export class DescribeClient {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private queue: Backend[] = [];
  private waiter: ((msg: Backend) => void) | undefined;
  private failed: Error | undefined;
  private readonly socket: Socket;
  private readonly target: DescribeTarget;

  /**
   * @param socket - Connected or connecting TCP socket
   * @param target - Startup and auth parameters
   */
  constructor(socket: Socket, target: DescribeTarget) {
    this.socket = socket;
    this.target = target;
    socket.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    socket.on("error", (error) => {
      this.fail(error);
    });
    socket.on("close", () => {
      this.fail(new Error("postgres connection closed"));
    });
  }

  /**
   * Startup and authentication. Resolves at the first ReadyForQuery.
   *
   * @returns This client
   */
  async open(): Promise<DescribeClient> {
    await once(this.socket, "connect");
    this.socket.write(startup(this.target));
    for (;;) {
      const msg = await this.next();
      if (msg.tag === READY) return this;
      if (msg.tag === AUTH) await this.authenticate(msg.body);
      else if (msg.tag === ERROR) throw errorOf(msg.body);
    }
  }

  /**
   * Describes one statement without executing it.
   *
   * @param text - SQL text. A multi-statement string is refused by the server
   * @returns Parameter OIDs, columns, or the server error
   */
  async describe(text: string): Promise<DescribeOutcome> {
    this.socket.write(Buffer.concat([parse(text), describeStatement(), sync()]));
    const parameterOids: number[] = [];
    const columns: DescribeColumn[] = [];
    let code: string | undefined;
    let message: string | undefined;
    for (;;) {
      const msg = await this.next();
      if (msg.tag === READY) {
        if (code === undefined) return { parameterOids, columns };
        if (message === undefined) return { parameterOids, columns, code };
        return { parameterOids, columns, code, message };
      }
      if (msg.tag === PARAM) parameterOids.push(...parameterOidsOf(msg.body));
      else if (msg.tag === ROW) columns.push(...columnsOf(msg.body));
      else if (msg.tag === ERROR) {
        const error = errorOf(msg.body);
        code ??= error.code;
        message ??= error.message;
      }
    }
  }

  /** Sends Terminate and closes the socket. */
  close(): void {
    this.socket.write(Buffer.from([88, 0, 0, 0, 4]));
    this.socket.end();
  }

  private async authenticate(body: Buffer): Promise<void> {
    const kind = body.readInt32BE(0);
    if (kind === 0 || kind === 12) return;
    if (kind === 3) {
      this.socket.write(passwordMessage(this.target.password));
      return;
    }
    if (kind === 5) {
      this.socket.write(passwordMessage(md5Password(this.target, body.subarray(4, 8))));
      return;
    }
    if (kind === 10) {
      await this.scram(body);
      return;
    }
    if (kind === 11) return;
    throw new Error(`unsupported postgres auth ${String(kind)}`);
  }

  private async scram(body: Buffer): Promise<void> {
    if (!body.toString("utf8").includes("SCRAM-SHA-256")) {
      throw new Error("server did not offer SCRAM-SHA-256");
    }
    const nonce = randomBytes(18).toString("base64");
    const bare = `n=*,r=${nonce}`;
    this.socket.write(saslInitial(`n,,${bare}`));
    const cont = await this.next();
    if (cont.tag !== AUTH || cont.body.readInt32BE(0) !== 11) {
      throw new Error("expected SCRAM continue");
    }
    const server = cont.body.toString("utf8", 4);
    const fields = scramFields(server);
    const salt = Buffer.from(fields.s ?? "", "base64");
    const rounds = Number(fields.i);
    const proof = scramProof(this.target.password, salt, rounds, bare, server, fields.r ?? "");
    this.socket.write(saslFinal(proof.clientFinal));
    const fin = await this.next();
    if (fin.tag === ERROR) throw errorOf(fin.body);
    if (fin.tag !== AUTH) throw new Error("expected SCRAM final");
    const kind = fin.body.readInt32BE(0);
    if (kind === 12) {
      const got = fin.body.toString("utf8", 4);
      if (got !== `v=${proof.server}`) throw new Error("SCRAM server signature mismatch");
      return;
    }
    if (kind !== 0) throw new Error(`unexpected auth after SCRAM ${String(kind)}`);
  }

  private drain(): void {
    while (this.buf.length >= 5) {
      const length = this.buf.readUInt32BE(1);
      const total = 1 + length;
      if (this.buf.length < total) return;
      const msg = { tag: this.buf[0] ?? 0, body: this.buf.subarray(5, total) };
      this.buf = this.buf.subarray(total);
      const waiter = this.waiter;
      if (waiter !== undefined) {
        this.waiter = undefined;
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    }
  }

  private next(): Promise<Backend> {
    if (this.failed !== undefined) return Promise.reject(this.failed);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      this.waiter = (msg) => {
        if (this.failed !== undefined) reject(this.failed);
        else resolve(msg);
      };
      this.rejectWaiter = reject;
    });
  }

  private rejectWaiter: ((error: Error) => void) | undefined;

  private fail(error: Error): void {
    if (this.failed !== undefined) return;
    this.failed = error;
    const reject = this.rejectWaiter;
    this.rejectWaiter = undefined;
    this.waiter = undefined;
    reject?.(error);
  }
}

/**
 * Parses a `postgres://` or `postgresql://` URL.
 *
 * @param url - Connection URL
 * @returns Host, port, user, password, and database
 */
export function parseTarget(url: string): DescribeTarget {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return {
    host: parsed.hostname,
    port: parsed.port.length === 0 ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

function startup(target: DescribeTarget): Buffer {
  const body = cstrings([
    ["user", target.user],
    ["database", target.database],
    ["client_encoding", "UTF8"],
  ]);
  const length = 8 + body.length;
  const out = Buffer.alloc(length);
  out.writeUInt32BE(length, 0);
  out.writeUInt32BE(196608, 4);
  body.copy(out, 8);
  return out;
}

function cstrings(pairs: readonly (readonly [string, string])[]): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of pairs) {
    parts.push(Buffer.from(key), Buffer.from([0]), Buffer.from(value), Buffer.from([0]));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function parse(text: string): Buffer {
  const sql = Buffer.from(text);
  const length = 4 + 1 + sql.length + 1 + 2;
  const out = Buffer.alloc(1 + length);
  out[0] = 80;
  out.writeUInt32BE(length, 1);
  out[5] = 0;
  sql.copy(out, 6);
  out[6 + sql.length] = 0;
  out.writeInt16BE(0, 7 + sql.length);
  return out;
}

function describeStatement(): Buffer {
  return Buffer.from([68, 0, 0, 0, 6, 83, 0]);
}

function sync(): Buffer {
  return Buffer.from([83, 0, 0, 0, 4]);
}

function passwordMessage(secret: string): Buffer {
  const bytes = Buffer.from(secret);
  const length = 4 + bytes.length + 1;
  const out = Buffer.alloc(1 + length);
  out[0] = 112;
  out.writeUInt32BE(length, 1);
  bytes.copy(out, 5);
  return out;
}

function saslInitial(clientFirst: string): Buffer {
  const mechanism = Buffer.from("SCRAM-SHA-256");
  const first = Buffer.from(clientFirst);
  const length = 4 + mechanism.length + 1 + 4 + first.length;
  const out = Buffer.alloc(1 + length);
  out[0] = 112;
  out.writeUInt32BE(length, 1);
  mechanism.copy(out, 5);
  out.writeUInt32BE(first.length, 6 + mechanism.length);
  first.copy(out, 10 + mechanism.length);
  return out;
}

function saslFinal(clientFinal: string): Buffer {
  const bytes = Buffer.from(clientFinal);
  const length = 4 + bytes.length;
  const out = Buffer.alloc(1 + length);
  out[0] = 112;
  out.writeUInt32BE(length, 1);
  bytes.copy(out, 5);
  return out;
}

function md5Password(target: DescribeTarget, salt: Buffer): string {
  const inner = createHash("md5")
    .update(target.password + target.user)
    .digest("hex");
  const outer = createHash("md5")
    .update(Buffer.concat([Buffer.from(inner), salt]))
    .digest("hex");
  return `md5${outer}`;
}

function scramFields(server: string): { r?: string; s?: string; i?: string } {
  const out: { r?: string; s?: string; i?: string } = {};
  for (const part of server.split(",")) {
    const key = part[0];
    if (key === "r" || key === "s" || key === "i") out[key] = part.slice(2);
  }
  return out;
}

function scramProof(
  password: string,
  salt: Buffer,
  rounds: number,
  bare: string,
  server: string,
  serverNonce: string,
): { clientFinal: string; server: string } {
  const salted = pbkdf2Sync(password, salt, rounds, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(clientKey).digest();
  const without = `c=biws,r=${serverNonce}`;
  const auth = `${bare},${server},${without}`;
  const signature = createHmac("sha256", stored).update(auth).digest();
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i += 1)
    proof[i] = (clientKey[i] ?? 0) ^ (signature[i] ?? 0);
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  const serverSig = createHmac("sha256", serverKey).update(auth).digest("base64");
  return { clientFinal: `${without},p=${proof.toString("base64")}`, server: serverSig };
}

function parameterOidsOf(body: Buffer): readonly number[] {
  const count = body.readInt16BE(0);
  const oids: number[] = [];
  for (let i = 0; i < count; i += 1) oids.push(body.readUInt32BE(2 + i * 4));
  return oids;
}

function columnsOf(body: Buffer): readonly DescribeColumn[] {
  const count = body.readInt16BE(0);
  const columns: DescribeColumn[] = [];
  let index = 2;
  for (let i = 0; i < count; i += 1) {
    const end = body.indexOf(0, index);
    const name = body.toString("utf8", index, end);
    index = end + 1;
    columns.push({
      name,
      tableOid: body.readUInt32BE(index),
      attnum: body.readInt16BE(index + 4),
      typeOid: body.readUInt32BE(index + 6),
      typeMod: body.readInt32BE(index + 12),
    });
    index += 18;
  }
  return columns;
}

function errorOf(body: Buffer): Error & { code?: string } {
  let message = "postgres error";
  let code: string | undefined;
  let index = 0;
  while (index < body.length) {
    const field = body[index];
    if (field === 0 || field === undefined) break;
    const end = body.indexOf(0, index + 1);
    const value = body.toString("utf8", index + 1, end);
    if (field === 77) message = value;
    if (field === 67) code = value;
    index = end + 1;
  }
  const error = new Error(message) as Error & { code?: string };
  if (code !== undefined) error.code = code;
  return error;
}

function once(socket: Socket, event: "connect"): Promise<void> {
  if (!socket.connecting) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once(event, () => {
      resolve();
    });
    socket.once("error", reject);
  });
}
