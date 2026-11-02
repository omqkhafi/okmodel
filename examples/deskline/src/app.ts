import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OkmError } from "okmodel";
import { db, type TenantDb } from "./db.ts";
import { hashKey } from "./hash.ts";

export const app = new Hono<{ Variables: { db: TenantDb } }>();

// 1. Find the tenant from the API key, then scope every query to it.
app.use(async (c, next) => {
  const parts = (c.req.header("authorization") ?? "").split(" ");
  const key = parts.length === 2 && parts[0].toLowerCase() === "bearer" ? parts[1] : "";
  const apiKey = key ? await db.api_keys.one({ where: { keyHash: hashKey(key) } }) : null;
  if (!apiKey) return c.json({ error: "unknown API key" }, 401);
  c.set("db", db.for({ tenantId: apiKey.tenantId }));
  await next();
});

// 2. List tickets, two per page.
app.get("/tickets", async (c) => {
  const page = await c.var.db.tickets.page({
    orderBy: { subject: "asc", id: "asc" },
    limit: 2,
    after: c.req.query("after"),
  });
  return c.json(page);
});

// 3. Open a ticket.
app.post("/tickets", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "body must be a JSON object" }, 400);
  }
  const ticket = await c.var.db.tickets.insert(body);
  return c.json(ticket, 201);
});

// 4. One place turns database errors into JSON.
app.onError((error) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }
  const { status, body } = OkmError.from(error).toHttp();
  return Response.json(body, { status });
});
