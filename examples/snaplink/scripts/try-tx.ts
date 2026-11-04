// Run from app/: DATABASE_URL=... bun scripts/try-tx.ts
import { OkmError } from "okmodel";
import { openDb } from "../src/db.ts";

const url = process.env.DATABASE_URL!;
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((...a: Parameters<typeof fetch>) => (fetches++, realFetch(...a))) as typeof fetch;

// 1. tx() in HTTP mode
{
  const db = await openDb(url, "http");
  await db.connected;
  const before = fetches;
  try {
    await db.tx(async (tx) => tx.links.insert({ slug: "never", url: "https://x.dev" }));
  } catch (e) {
    const err = OkmError.from(e);
    console.log("http tx():", err.code, err.kind, "-", err.message);
    console.log("fetches during tx():", fetches - before);
  }
  await db.close();
}

// 2. Rollback in WebSocket mode
{
  const db = await openDb(url, "websocket");
  try {
    await db.tx(async (tx) => {
      await tx.links.insert({ slug: "rolled-back", url: "https://x.dev" });
      throw new Error("boom");
    });
  } catch (e) {
    console.log("ws tx threw:", (e as Error).message);
  }
  console.log("row after rollback:", await db.links.one({ where: { slug: "rolled-back" } }));

  // 3. A call after close()
  await db.close();
  try {
    await db.links.count();
  } catch (e) {
    const err = OkmError.from(e);
    console.log("after close():", err.code, err.kind, "retryable:", err.retryable, "-", err.message);
  }
}
