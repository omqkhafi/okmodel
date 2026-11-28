/**
 * `stop()` from inside a handler waits when `getBuiltinModule` is missing.
 *
 * Spawned by `watch-stop-fallback.test.ts` so the watch module loads in a
 * process that has already hidden the built-in. A hung wait exits by timeout.
 */

const record = globalThis.process as { getBuiltinModule?: (id: string) => unknown };
delete record.getBuiltinModule;
if (typeof record.getBuiltinModule === "function") {
  console.error("getBuiltinModule stayed callable");
  process.exit(2);
}

const { open } = await import("../src/adapters/pg/pglite.js");
const { schema, table, t } = await import("../src/dialects/pg/index.js");
const { connect } = await import("../src/runtime/pg/pglite.js");

const orders = table(
  "orders",
  { id: t.integer().primaryKey(), status: t.text() },
  { watch: { push: false } },
);
const app = schema({ casing: "snake", tables: [orders] });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const pool = await open();
try {
  await pool.execute("create table orders (id integer primary key, status text)");
  const db = await connect(pool, { schema: app });
  await db.connected;
  try {
    let settled = false;
    let handle!: { stop: () => Promise<void>; run: () => Promise<void> };
    handle = db.orders.watch(
      async () => {
        const pending = handle.stop().then(() => {
          settled = true;
        });
        await sleep(40);
        if (settled) {
          console.error("stop() resolved inside the handler without AsyncLocalStorage");
          process.exit(1);
        }
        void pending;
      },
      { every: "1s" },
    );
    const raced = await Promise.race([
      handle.run().then(() => "ran" as const),
      sleep(3_000).then(() => "timeout" as const),
    ]);
    if (raced !== "ran") {
      console.error("handler did not finish");
      process.exit(1);
    }
    await sleep(30);
    if (!settled) {
      console.error("stop() did not settle after the handler returned");
      process.exit(1);
    }
  } finally {
    await db.close();
  }
} finally {
  await pool.close();
}
