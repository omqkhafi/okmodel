import { Hono, type MiddlewareHandler } from "hono";
import { OkmError } from "okmodel";
import type { NeonMode } from "okmodel/pg/neon";

import { neonMode, openDb, type Db } from "./db.ts";

type Vars = { mode: NeonMode; db: Db; pending: Promise<unknown>[] };
type AppEnv = { Bindings: CloudflareBindings; Variables: Vars };

const app = new Hono<AppEnv>();

// Read NEON_MODE once per request. Widen to string: wrangler types makes it a literal.
app.use(async (c, next) => {
  const mode: string = c.env.NEON_MODE;
  c.set("mode", neonMode(mode));
  await next();
});

// One client per request. Close it after the response AND any background work.
const withDb: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = await openDb(c.env.DATABASE_URL, c.get("mode"));
  const pending: Promise<unknown>[] = [];
  c.set("db", db);
  c.set("pending", pending);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(settleThenClose(db, pending));
  }
};

// allSettled never rejects, so failed writes must be logged by hand.
async function settleThenClose(db: Db, pending: Promise<unknown>[]) {
  const results = await Promise.allSettled(pending);
  for (const r of results) {
    if (r.status === "rejected") console.error("background write failed", r.reason);
  }
  await db.close();
}

app.get("/health", (c) => c.json({ ok: true, mode: c.get("mode") }));

app.use("/links/*", withDb);
app.use("/r/*", withDb);

// Create a short link.
app.post("/links", async (c) => {
  const input = await readLink(c.req.raw);
  if ("error" in input) return c.json(input, 400);
  try {
    const link = await c.get("db").links.insert(input);
    return c.json(link, 201);
  } catch (error) {
    if (OkmError.is(error, "unique")) return c.json({ error: "slug taken" }, 409);
    throw error;
  }
});

// Redirect now, record the click after the response.
app.get("/r/:slug", async (c) => {
  const db = c.get("db");
  const link = await db.links.one({ where: { slug: c.req.param("slug") } });
  if (link === null) return c.text("not found", 404);
  c.get("pending").push(db.clicks.insert({ linkId: link.id }));
  return c.redirect(link.url, 302);
});

// Link, click count, and the last five clicks.
app.get("/links/:slug", async (c) => {
  const db = c.get("db");
  const link = await db.links.one({ where: { slug: c.req.param("slug") } });
  if (link === null) return c.json({ error: "not found" }, 404);
  const [total, recent] = await Promise.all([
    db.clicks.count({ where: { linkId: link.id } }),
    db.clicks.find({
      where: { linkId: link.id },
      orderBy: { id: "desc" },
      limit: 5,
    }),
  ]);
  return c.json({ ...link, clicks: total, recent: recent.map((r) => r.clickedAt) });
});

// Delete a link and its clicks together.
app.delete("/links/:slug", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug");
  if (c.get("mode") === "websocket") {
    // Interactive transaction: read, then write, on one connection.
    const deleted = await db.tx(async (tx) => {
      const link = await tx.links.one({ where: { slug } });
      if (link === null) return false;
      await tx.clicks.delete({ where: { linkId: link.id } });
      await tx.links.delete({ where: { id: link.id } });
      return true;
    });
    return deleted ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  }
  // HTTP: no interactive transaction. Read first, then one atomic batch.
  const link = await db.links.one({ where: { slug } });
  if (link === null) return c.json({ error: "not found" }, 404);
  await db.batch([
    db.clicks.delete({ where: { linkId: link.id } }),
    db.links.delete({ where: { id: link.id } }),
  ]);
  return c.body(null, 204);
});

app.notFound((c) => c.text("not found", 404));

type LinkInput = { slug: string; url: string };

async function readLink(request: Request): Promise<LinkInput | { error: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: "body must be JSON" };
  }
  const { url, slug } = (body ?? {}) as Record<string, unknown>;
  if (typeof url !== "string" || !/^https?:$/.test(URL.parse(url)?.protocol ?? "")) {
    return { error: "url must be an http(s) URL" };
  }
  if (slug !== undefined && (typeof slug !== "string" || !/^[a-z0-9-]{3,32}$/.test(slug))) {
    return { error: "slug must be 3-32 chars of a-z, 0-9, -" };
  }
  return { url, slug: slug ?? crypto.randomUUID().slice(0, 8) };
}

export default app;
