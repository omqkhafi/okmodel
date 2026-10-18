#!/usr/bin/env bun
/**
 * Minimal postgres.js kill-storm reproduction (no OKModel).
 *
 * Shows that `pg_terminate_backend` during concurrent queries raises
 * uncaught `TypeError` from `connection.js` `nextWrite` (`socket.write` on
 * null) and unhandled rejections (`CONNECTION_CLOSED`, 57P01).
 *
 * Peer: postgres@3.4.9 (see package.json / this file's header in
 * docs/postgresjs-kill-storm.md).
 *
 * Usage:
 *   DATABASE_URL=postgres://… bun docs/postgresjs-kill-storm.mjs
 *   DATABASE_URL=postgres://… node docs/postgresjs-kill-storm.mjs
 *
 * Exit 0 only when zero uncaught / unhandled events were observed.
 */

import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
if (url === "") {
  console.error("usage: DATABASE_URL=postgres://… bun docs/postgresjs-kill-storm.mjs");
  process.exit(2);
}

const crashes = [];
process.on("uncaughtException", (error) => {
  crashes.push([
    "uncaught",
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  ]);
});
process.on("unhandledRejection", (error) => {
  crashes.push([
    "rejection",
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  ]);
});

const admin = postgres(url, { max: 1, fetch_types: false, onnotice: () => undefined });
const stamp = `${String(process.pid)}_${String(Date.now())}`;
const schema = `pgjs_storm_${stamp}`;
const role = `pgjs_r_${stamp}`;
const password = "stormsecret";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

try {
  await admin.unsafe(`create schema ${schema}`);
  await admin.unsafe(`create table ${schema}.items (id serial primary key, name text)`);
  for (let i = 0; i < 8; i += 1) {
    await admin.unsafe(`insert into ${schema}.items (name) values ('n${String(i)}')`);
  }
  const database = new URL(url).pathname.replace(/^\//, "") || "okm";
  await admin.unsafe(`create role ${role} login password '${password}' nosuperuser`);
  await admin.unsafe(`grant connect on database ${database} to ${role}`);
  await admin.unsafe(`grant usage on schema ${schema} to ${role}`);
  await admin.unsafe(
    `grant select, insert, update, delete on all tables in schema ${schema} to ${role}`,
  );
  await admin.unsafe(`grant usage, select on all sequences in schema ${schema} to ${role}`);

  const appUrl = new URL(url);
  appUrl.username = role;
  appUrl.password = password;
  const sql = postgres(appUrl.toString(), {
    max: 4,
    fetch_types: false,
    connection: { search_path: schema },
    backoff: () => 0.05 + Math.random() * 0.2,
  });

  let killer = true;
  const killLoop = (async () => {
    while (killer) {
      await admin
        .unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role}'`,
        )
        .catch(() => undefined);
      await sleep(20);
    }
  })();

  const deadline = Date.now() + 3000;
  const inflight = new Set();
  const workers = Array.from({ length: 6 }, async (_, worker) => {
    let n = 0;
    while (Date.now() < deadline) {
      n += 1;
      const kind = (worker + n) % 3;
      let pending;
      if (kind === 0) pending = sql`select * from items limit 5`;
      else if (kind === 1) pending = sql`select count(*)::int from items`;
      else
        pending = sql.begin(async (tx) => {
          await tx`select count(*)::int from items`;
        });
      const tracked = Promise.race([
        pending,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("call timeout")), 5000);
        }),
      ]).catch(() => undefined);
      inflight.add(tracked);
      void tracked.finally(() => {
        inflight.delete(tracked);
      });
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
  });

  await Promise.all(workers);
  killer = false;
  await Promise.all([...inflight]).catch(() => undefined);
  await sleep(150);
  await killLoop.catch(() => undefined);
  await sql.end({ timeout: 1 }).catch(() => undefined);

  const socket = crashes.filter(([, message]) =>
    /socket\.write|reading 'write'/.test(message),
  ).length;
  const report = {
    postgres: "3.4.9",
    crashes: crashes.length,
    socket,
    samples: crashes.slice(0, 8),
  };
  console.log(JSON.stringify(report));
  await cleanup();
  process.exit(crashes.length === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  await cleanup();
  process.exit(2);
}

async function cleanup() {
  await admin.unsafe(`drop owned by ${role} cascade`).catch(() => undefined);
  await admin.unsafe(`drop role if exists ${role}`).catch(() => undefined);
  await admin.unsafe(`drop schema if exists ${schema} cascade`).catch(() => undefined);
  await admin.end({ timeout: 1 }).catch(() => undefined);
}
