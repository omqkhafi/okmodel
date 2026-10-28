/**
 * The Session settings handbook page applies on a real Postgres.
 *
 * `policy.sql` runs as written. `session.ts` and `tenancy.ts` run as written
 * against the role that page says to use, one that owns nothing.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import type { Catalog } from "../src/contracts/catalog/types.js";

const root = join(import.meta.dir, "..");
const page = join(root, "site/content/docs/operate/session-settings.mdx");

const USER_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const USER_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
  ["okmodel/session", join(root, "src/runtime/session/index.ts")],
  ["okmodel/tenancy", join(root, "src/runtime/tenancy/index.ts")],
];

const gate = await loadPostgresGate();

type Docs = { readonly id: string; readonly ownerId: string; readonly title: string };

type Policy = {
  mine(url: string, userId: string): Promise<readonly Docs[]>;
};

type Tenancy = {
  readonly app?: { readonly catalog: Catalog };
  list(url: string, tenantId: string, userId: string): Promise<readonly (readonly unknown[])[]>;
};

postgresTest(
  gate,
  "the session settings page applies: the policy sql, session.ts, and tenancy.ts",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const role = `okm_docs_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    try {
      await admin.unsafe(fence("sql", "policy.sql"));
      await admin.unsafe(`create role ${role} login password 'docsapp'`);
      await admin.unsafe(`grant select, insert on docs to ${role}`);
      await admin.unsafe(`grant usage on schema public to ${role}`);
      const url = new URL(database.url);
      url.username = role;
      url.password = "docsapp";

      const policy = (await load("session.ts")) as Policy;
      const first = await policy.mine(url.href, USER_A);
      expect(first.map((row) => [row.ownerId, row.title])).toEqual([[USER_A, "hello"]]);
      const second = await policy.mine(url.href, USER_B);
      expect(second.map((row) => [row.ownerId, row.title])).toEqual([[USER_B, "hello"]]);
      const all = await admin.unsafe("select count(*) as n from docs");
      expect(all[0]?.n).toBe("2");

      const tenancy = (await load("tenancy.ts")) as Tenancy;
      if (tenancy.app === undefined) throw new Error("tenancy.ts exports no app");
      for (const statement of renderCatalog(tenancy.app.catalog, "public")) {
        await admin.unsafe(statement);
      }
      await admin.unsafe(`grant select, insert on notes to ${role}`);
      await admin.unsafe(`grant usage on all sequences in schema public to ${role}`);
      const listed = await tenancy.list(url.href, TENANT, USER_A);
      expect(listed).toEqual([[], []]);
    } finally {
      await admin.end({ timeout: 5 });
      const cleanup = openPostgres();
      try {
        await cleanup.unsafe(`drop owned by ${role}`).catch(() => undefined);
        await cleanup.unsafe(`drop role if exists ${role}`).catch(() => undefined);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
      await database.close();
    }
  },
  120_000,
);

/**
 * The body of the fence with this language and title.
 *
 * @param lang - Fence language
 * @param title - Fence `title`
 * @returns The fence source
 */
function fence(lang: string, title: string): string {
  const text = readFileSync(page, "utf8");
  const pattern = new RegExp(`\`\`\`${lang} title="${title}"\\n([\\s\\S]*?)\`\`\``);
  const body = pattern.exec(text)?.[1];
  if (body === undefined) throw new Error(`session-settings.mdx is missing ${title}`);
  return body;
}

/**
 * Imports one TypeScript fence with package imports pointed at `src/`.
 *
 * @param title - Fence `title`
 * @returns The fence module
 */
async function load(title: string): Promise<object> {
  let body = fence("ts", title);
  for (const [specifier, path] of imports) {
    body = body.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "okm-docs-session-"));
  const file = join(dir, title);
  try {
    writeFileSync(file, body);
    return (await import(`${pathToFileURL(file).href}?session=${title}`)) as object;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
