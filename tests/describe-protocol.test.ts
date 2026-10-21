/**
 * The describe client against a fake server: SQLSTATE, a row description, and TLS.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createTcp, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

import { expect, test } from "bun:test";

import {
  connectDescribe,
  describeTls,
  type DescribeClient,
} from "../src/tooling/describe/protocol.js";

test("sslmode and the host decide TLS before a socket opens", () => {
  expect(describeTls("postgres://u@localhost/app")).toBe("off");
  expect(describeTls("postgres://u@127.0.0.1/app")).toBe("off");
  expect(describeTls("postgres://u@[::1]/app")).toBe("off");
  expect(describeTls("postgres://u@db.example/app")).toBe("require");
  expect(describeTls("postgres://u@db.example/app?sslmode=disable")).toBe("off");
  expect(describeTls("postgres://u@localhost/app?sslmode=require")).toBe("require");
  expect(describeTls("postgres://u@localhost/app?sslmode=verify-full")).toBe("verify-full");
  expect(describeTls("postgres://u@localhost/app?sslmode=verify-ca")).toBe("verify-ca");
});

test("a pooler host is refused before connect", () => {
  expect(() => connectDescribe("postgres://u@db.pooler.example/app")).toThrow(/pooler/);
});

test("Parse errors keep their SQLSTATE", async () => {
  const missing = await serve((socket) => {
    reply(socket, errorResponse("42P01", 'relation "spike.missing" does not exist'));
  });
  const multi = await serve((socket) => {
    reply(
      socket,
      errorResponse("42601", "cannot insert multiple commands into a prepared statement"),
    );
  });
  try {
    const missingClient = await connectDescribe(missing.url);
    const multiClient = await connectDescribe(multi.url);
    try {
      expect(await missingClient.describe("select * from spike.missing")).toMatchObject({
        code: "42P01",
      });
      expect(await multiClient.describe("select 1; select 2")).toMatchObject({ code: "42601" });
    } finally {
      missingClient.close();
      multiClient.close();
    }
  } finally {
    missing.close();
    multi.close();
  }
});

test("a successful describe reads parameter OIDs and row fields", async () => {
  const server = await serve((socket, chunk) => {
    if (chunk[0] === 81) {
      socket.write(Buffer.concat([dataRow(["1"]), ready()]));
      return;
    }
    socket.write(Buffer.concat([parameterDescription([23]), rowDescription("n", 23), ready()]));
  });
  let client: DescribeClient | undefined;
  try {
    client = await connectDescribe(server.url);
    const outcome = await client.describe("select $1::int as n");
    expect(outcome.code).toBeUndefined();
    expect(outcome.parameterOids).toEqual([23]);
    expect(outcome.columns).toEqual([
      { name: "n", tableOid: 0, attnum: 0, typeOid: 23, typeMod: -1 },
    ]);
    const rows = await client.query("select 1");
    expect(rows).toEqual([["1"]]);
  } finally {
    client?.close();
    server.close();
  }
});

test("sslmode=require upgrades after SSLRequest and still describes", async () => {
  const material = certificate();
  const server = await serveTls(material, (socket) => {
    reply(socket, Buffer.concat([rowDescription("n", 23), ready()]));
  });
  let client: DescribeClient | undefined;
  try {
    client = await connectDescribe(`${server.url}?sslmode=require`);
    const outcome = await client.describe("select 1 as n");
    expect(outcome.columns[0]?.name).toBe("n");
    expect(outcome.columns[0]?.typeOid).toBe(23);
  } finally {
    client?.close();
    server.close();
  }
});

test("a server that refuses SSL fails the require path", async () => {
  const server = await serveRaw((socket, chunk) => {
    expect([...chunk.subarray(0, 8)]).toEqual([0, 0, 0, 8, 4, 210, 22, 47]);
    socket.write("N");
  });
  try {
    let caught: unknown;
    try {
      await connectDescribe(`${server.url}?sslmode=require`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) expect(caught.message).toMatch(/refused SSL/);
  } finally {
    server.close();
  }
});

type Material = { readonly key: string; readonly cert: string };

function certificate(): Material {
  const dir = mkdtempSync(join(tmpdir(), "okm-tls-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

type Listening = { readonly url: string; close(): void };

function serve(onQuery: (socket: Socket, chunk: Buffer) => void): Promise<Listening> {
  return listen((socket) => {
    let stage = 0;
    socket.on("data", (chunk: Buffer) => {
      stage += 1;
      if (stage === 1) {
        socket.write(Buffer.concat([authOk(), ready()]));
        return;
      }
      onQuery(socket, chunk);
    });
  });
}

function serveRaw(onData: (socket: Socket, chunk: Buffer) => void): Promise<Listening> {
  return listen((socket) => {
    socket.once("data", (chunk: Buffer) => {
      onData(socket, chunk);
    });
  });
}

function serveTls(material: Material, onQuery: (socket: Socket) => void): Promise<Listening> {
  return listen((socket) => {
    socket.once("data", (chunk: Buffer) => {
      expect([...chunk.subarray(0, 8)]).toEqual([0, 0, 0, 8, 4, 210, 22, 47]);
      socket.pause();
      const secure = new TLSSocket(socket, {
        isServer: true,
        key: material.key,
        cert: material.cert,
      });
      let stage = 0;
      secure.on("data", () => {
        stage += 1;
        if (stage === 1) {
          secure.write(Buffer.concat([authOk(), ready()]));
          return;
        }
        onQuery(secure);
      });
      secure.on("error", () => undefined);
      socket.write("S");
      socket.resume();
    });
  });
}

function listen(onSocket: (socket: Socket) => void): Promise<Listening> {
  const server: Server = createTcp((socket) => {
    socket.on("error", () => undefined);
    onSocket(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing port");
      resolve({
        url: `postgres://okm@127.0.0.1:${String(address.port)}/app`,
        close() {
          server.close();
        },
      });
    });
  });
}

function reply(socket: Socket, body: Buffer): void {
  socket.write(body);
}

function authOk(): Buffer {
  const out = Buffer.alloc(9);
  out[0] = 82;
  out.writeUInt32BE(8, 1);
  out.writeInt32BE(0, 5);
  return out;
}

function ready(): Buffer {
  return Buffer.from([90, 0, 0, 0, 5, 73]);
}

function errorResponse(code: string, message: string): Buffer {
  const fields = Buffer.concat([
    field(83, "ERROR"),
    field(86, "ERROR"),
    field(67, code),
    field(77, message),
    Buffer.from([0]),
  ]);
  const length = 4 + fields.length;
  const out = Buffer.alloc(1 + length);
  out[0] = 69;
  out.writeUInt32BE(length, 1);
  fields.copy(out, 5);
  return Buffer.concat([out, ready()]);
}

function field(tag: number, value: string): Buffer {
  return Buffer.concat([Buffer.from([tag]), Buffer.from(value), Buffer.from([0])]);
}

function parameterDescription(oids: readonly number[]): Buffer {
  const body = Buffer.alloc(2 + oids.length * 4);
  body.writeInt16BE(oids.length, 0);
  for (let i = 0; i < oids.length; i += 1) body.writeUInt32BE(oids[i] ?? 0, 2 + i * 4);
  return message(116, body);
}

function rowDescription(name: string, typeOid: number): Buffer {
  const fieldName = Buffer.from(name);
  const body = Buffer.alloc(2 + fieldName.length + 1 + 18);
  body.writeInt16BE(1, 0);
  fieldName.copy(body, 2);
  const index = 2 + fieldName.length + 1;
  body.writeUInt32BE(0, index);
  body.writeInt16BE(0, index + 4);
  body.writeUInt32BE(typeOid, index + 6);
  body.writeInt16BE(-1, index + 10);
  body.writeInt32BE(-1, index + 12);
  body.writeInt16BE(0, index + 16);
  return message(84, body);
}

function dataRow(values: readonly (string | null)[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(2)];
  parts[0]?.writeInt16BE(values.length, 0);
  for (const value of values) {
    if (value === null) {
      const len = Buffer.alloc(4);
      len.writeInt32BE(-1, 0);
      parts.push(len);
      continue;
    }
    const bytes = Buffer.from(value);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    parts.push(len, bytes);
  }
  return message(68, Buffer.concat(parts));
}

function message(tag: number, body: Buffer): Buffer {
  const length = 4 + body.length;
  const out = Buffer.alloc(1 + length);
  out[0] = tag;
  out.writeUInt32BE(length, 1);
  body.copy(out, 5);
  return out;
}
