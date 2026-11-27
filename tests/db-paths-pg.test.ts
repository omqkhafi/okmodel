/**
 * Dotted composite fields and to-one paths in `db.*` on real Postgres.
 *
 * Path keys are resolved when the statement is planned. The static call types
 * do not list them: wiring that list moves the type ceilings (D350). The
 * helper below keeps the runtime value and satisfies the checker.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { contains, eq, many, one, schema, t, table } from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy, global, via } from "../src/runtime/tenancy/index.js";

const gate = await loadPostgresGate();

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const ORG_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c11";
const ORG_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c12";

const geo = t.composite("geo", {
  city: t.text(),
  zone: t.integer(),
});

const address = t.composite("address", {
  city: t.text(),
  n: t.integer(),
  pop: t.bigint(),
  price: t.numeric(10, 2),
  geo,
  kind: t.enum("place_kind", ["home", "work"]),
  code: t.domain("place_code", t.text(), "length(VALUE) > 0"),
  tags: t.text().array(),
});

const people = table(
  "people",
  {
    id: t.integer().primaryKey(),
    home: address,
    work: address.nullable(),
  },
  { tenancy: global("composite paths are not tenant rows") },
);

const authors = table("authors", {
  id: t.uuid().primaryKey(),
  name: t.text(),
  home: address,
});

const books = table(
  "books",
  {
    id: t.integer().primaryKey(),
    title: t.text(),
    authorId: t.uuid().references("authors"),
  },
  { relations: { author: one("authors", "authorId") } },
);

const organizations = table("organizations", {
  id: t.uuid().primaryKey(),
  name: t.text(),
});

const projects = table(
  "projects",
  {
    id: t.uuid().primaryKey(),
    name: t.text(),
    organizationId: t.uuid().references("organizations"),
  },
  {
    tenancy: via("organization"),
    relations: { organization: one("organizations", "organizationId") },
  },
);

const tickets = table(
  "tickets",
  {
    id: t.integer().primaryKey(),
    title: t.text(),
    projectId: t.uuid().references("projects"),
  },
  { relations: { project: one("projects", "projectId") } },
);

const tasks = table("tasks", {
  id: t.integer().primaryKey(),
  title: t.text(),
  personId: t.integer().references("people"),
});

const peopleWithTasks = table(
  "people",
  {
    id: t.integer().primaryKey(),
    home: address,
    work: address.nullable(),
  },
  { relations: { tasks: many("tasks") } },
);

/** The path schema. `tasks` is declared as to-one so a many path can be refused. */
const manyApp = schema({
  tables: [peopleWithTasks, tasks],
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [people, authors, books, organizations, projects, tickets],
});

type Db = ReturnType<typeof connect<typeof app>>;

/**
 * Keeps a call object the path resolver accepts.
 *
 * The public overloads do not list dotted keys. `never` still carries the
 * object at runtime, and the first overload accepts it.
 *
 * @param value - The call
 * @returns That call, typed so the checker does not seal the dotted keys
 */
function raw<T>(value: T): never {
  return value as never;
}

async function sqlText(handle: { sql(): unknown }): Promise<string> {
  const value = await handle.sql();
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "statements" in value) {
    const statements = value.statements;
    if (Array.isArray(statements)) {
      return statements
        .map((item) =>
          item !== null && typeof item === "object" && "text" in item ? String(item.text) : "",
        )
        .join("\n");
    }
  }
  if (value !== null && typeof value === "object" && "text" in value) {
    return String(value.text);
  }
  return JSON.stringify(value);
}

const home = {
  city: "Riyadh",
  n: 7,
  pop: "100",
  price: "1.50",
  geo: { city: "Olaya", zone: 3 },
  kind: "home" as const,
  code: "ab",
  tags: ["a", "b"],
};

const other = {
  ...home,
  city: "Jeddah",
  n: 2,
  pop: "50",
  price: "2.00",
  geo: { city: "Corniche", zone: 1 },
  kind: "work" as const,
  code: "cd",
  tags: ["b"],
};

async function withApp(run: (db: Db) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      await run(db);
    } finally {
      await db.close();
    }
  });
}

postgresTest(
  gate,
  "proof:query.paths",
  async () => {
    await withApp(async (db) => {
      await db.people.insert({ id: 1, home, work: null }, { returning: ["id"] });
      const again = await db.people.find({ where: { id: 1 }, select: ["id"], limit: 5 });
      expect(again).toEqual([{ id: 1 }]);

      await db.people.insert({ id: 2, home: other, work: home }, { returning: ["id"] });

      const whereCity = await db.people.find(
        raw({ where: { "home.city": "Riyadh" }, select: ["id"], limit: 10 }),
      );
      expect(whereCity.map((row: { id: number }) => row.id).sort((a, b) => a - b)).toEqual([1]);

      const selected = await db.people.find(
        raw({
          select: ["id", "home.city", "home.n", "home.pop", "home.price", "home.geo.city"],
          orderBy: { "home.city": "asc" },
          limit: 10,
        }),
      );
      expect(selected as unknown).toEqual([
        {
          id: 2,
          "home.city": "Jeddah",
          "home.n": 2,
          "home.pop": "50",
          "home.price": "2.00",
          "home.geo.city": "Corniche",
        },
        {
          id: 1,
          "home.city": "Riyadh",
          "home.n": 7,
          "home.pop": "100",
          "home.price": "1.50",
          "home.geo.city": "Olaya",
        },
      ]);

      const byNumber = await db.people.find(
        raw({ where: { "home.n": 7 }, select: ["id"], limit: 5 }),
      );
      expect(byNumber as unknown).toEqual([{ id: 1 }]);

      const byPop = await db.people.find(
        raw({
          where: { "home.pop": "100" },
          select: ["id"],
          orderBy: { "home.pop": "desc" },
          limit: 5,
        }),
      );
      expect(byPop as unknown).toEqual([{ id: 1 }]);

      const byPrice = await db.people.find(
        raw({ where: { "home.price": "1.50" }, select: ["id"], limit: 5 }),
      );
      expect(byPrice as unknown).toEqual([{ id: 1 }]);

      const byKind = await db.people.find(
        raw({ where: { "home.kind": "work" }, select: ["id"], limit: 5 }),
      );
      expect(byKind as unknown).toEqual([{ id: 2 }]);

      const byCode = await db.people.find(
        raw({ where: { "home.code": "ab" }, select: ["id"], limit: 5 }),
      );
      expect(byCode as unknown).toEqual([{ id: 1 }]);

      const byTag = await db.people.find(
        raw({ where: { "home.tags": eq(["a", "b"]) }, select: ["id"], limit: 5 }),
      );
      expect(byTag as unknown).toEqual([{ id: 1 }]);

      const byContains = await db.people.find(
        raw({ where: { "home.tags": contains(["a"]) }, select: ["id"], limit: 5 }),
      );
      expect(byContains as unknown).toEqual([{ id: 1 }]);

      const nested = await db.people.find(
        raw({ where: { "home.geo.zone": 3 }, select: ["id", "home.geo.city"], limit: 5 }),
      );
      expect(nested as unknown).toEqual([{ id: 1, "home.geo.city": "Olaya" }]);

      const missingWork = await db.people.find(
        raw({ where: { id: 1 }, select: ["id", "work.city"], limit: 5 }),
      );
      expect(missingWork as unknown).toEqual([{ id: 1, "work.city": null }]);

      const noNullMatch = await db.people.find(
        raw({ where: { "work.city": "Riyadh" }, select: ["id"], limit: 5 }),
      );
      expect(noNullMatch as unknown).toEqual([{ id: 2 }]);

      const grouped = await db.people.aggregate(
        raw({
          groupBy: ["home.city"],
          count: true,
          orderBy: { "home.city": "asc" },
          limit: 10,
        }),
      );
      expect(grouped as unknown).toEqual([
        { "home.city": "Jeddah", count: 1 },
        { "home.city": "Riyadh", count: 1 },
      ]);

      const planned = await sqlText(
        db.people.find(raw({ where: { "home.city": "Riyadh" }, select: ["id"], limit: 5 })),
      );
      expect(planned).toContain('(t."home")."city"');
      expect(planned).not.toContain("(home).city");

      const updated = await db.people.update(
        raw({ where: { id: 1 }, set: { "home.city": "Dammam" } }),
      );
      expect(updated.count).toBe(1);
      const setSql = await sqlText(
        db.people.update(raw({ where: { id: 2 }, set: { "home.city": "Mecca" } })),
      );
      expect(setSql).toContain('"home"."city"');
      const after = await db.people.find(
        raw({ where: { "home.city": "Dammam" }, select: ["id"], limit: 5 }),
      );
      expect(after as unknown).toEqual([{ id: 1 }]);

      const unknown = db.people.find(raw({ where: { "home.nope": "x" }, limit: 1 }));
      let error: unknown;
      try {
        await unknown.sql();
        error = new Error("expected OKM1120");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OkmError);
      if (!(error instanceof OkmError)) throw error;
      expect(error.code).toBe("OKM1120");
      expect(error.message).toContain("home.nope");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a to-one path keeps the joined table's tenant predicate",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      const authorA = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9ca1";
      const authorB = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9ca2";
      await a.authors.insert({ id: authorA, name: "Ada", home }, { returning: ["id"] });
      await b.authors.insert({ id: authorB, name: "Ada", home: other }, { returning: ["id"] });
      await a.books.insert({ id: 1, title: "Visible", authorId: authorA });
      await b.books.insert({ id: 2, title: "Other", authorId: authorB });

      const rows = await a.books.find(
        raw({
          where: { "author.name": "Ada" },
          select: ["id", "author.name"],
          orderBy: { id: "asc" },
          limit: 10,
        }),
      );
      expect(rows as unknown).toEqual([{ id: 1, "author.name": "Ada" }]);

      const sql = await sqlText(
        a.books.find(raw({ where: { "author.home.city": "Riyadh" }, select: ["id"], limit: 5 })),
      );
      expect(sql).toContain('j1."tenant_id"');
      expect(sql).toContain('(j1."home")."city"');
      const city = await a.books.find(
        raw({ where: { "author.home.city": "Riyadh" }, select: ["id"], limit: 5 }),
      );
      expect(city as unknown).toEqual([{ id: 1 }]);

      const deeper = a.books.find(raw({ where: { "author.org.name": "x" }, limit: 1 }));
      let deeperError: unknown;
      try {
        await deeper.sql();
        deeperError = new Error("expected OKM1120");
      } catch (caught) {
        deeperError = caught;
      }
      expect(deeperError).toBeInstanceOf(OkmError);
      if (deeperError instanceof OkmError) expect(deeperError.code).toBe("OKM1120");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a to-one path through via() keeps the exists predicate",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await a.organizations.insert({ id: ORG_A, name: "Alpha" });
      await b.organizations.insert({ id: ORG_B, name: "Beta" });
      const projectA = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9cb1";
      const projectB = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9cb2";
      await a.projects.insert({ id: projectA, name: "Road", organizationId: ORG_A });
      await b.projects.insert({ id: projectB, name: "Hidden", organizationId: ORG_B });
      await a.tickets.insert({ id: 1, title: "Own", projectId: projectA });
      await a.tickets.insert({ id: 2, title: "Foreign", projectId: projectB });

      const sql = await sqlText(
        a.tickets.find(raw({ where: { "project.name": "Hidden" }, select: ["id"], limit: 5 })),
      );
      expect(sql.toLowerCase()).toContain("exists (");
      const hidden = await a.tickets.find(
        raw({ where: { "project.name": "Hidden" }, select: ["id"], limit: 5 }),
      );
      expect(hidden as unknown).toEqual([]);
      const own = await a.tickets.find(
        raw({ where: { "project.name": "Road" }, select: ["id", "project.name"], limit: 5 }),
      );
      expect(own as unknown).toEqual([{ id: 1, "project.name": "Road" }]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a many relation path is refused before SQL",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(manyApp.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: manyApp, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const handle = db.people.find(raw({ where: { "tasks.title": "x" }, limit: 1 }));
        let manyError: unknown;
        try {
          await handle.sql();
          manyError = new Error("expected OKM1120");
        } catch (caught) {
          manyError = caught;
        }
        expect(manyError).toBeInstanceOf(OkmError);
        if (manyError instanceof OkmError) expect(manyError.code).toBe("OKM1120");
      } finally {
        await db.close();
      }
    });
  },
  30_000,
);
