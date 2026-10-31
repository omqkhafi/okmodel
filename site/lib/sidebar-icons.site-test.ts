/**
 * Sidebar groups are the capability folders, and every page has an icon.
 */

import { expect, test } from "bun:test";

import { hasSidebarIcon } from "./sidebar-icons";
import { source } from "./source";

test("pages sit flat under the capability groups", () => {
  const folders = source.getPageTree().children.flatMap((node) => (node.type === "folder" ? [node] : []));
  expect(folders.map((folder) => folder.name)).toEqual([
    "Get started",
    "Concepts",
    "Schema",
    "Queries",
    "Migrations",
    "Operate",
    "Reference",
    "AI Resources",
  ]);
  for (const folder of folders) {
    expect(folder.children.every((child) => child.type === "page")).toBe(true);
  }
  const urls = folders.flatMap((folder) => folder.children.flatMap((child) => (child.type === "page" ? [child.url] : [])));
  expect(urls).toContain("/docs/reference/cli");
  expect(urls).toContain("/docs/reference/errors");
  expect(urls).toContain("/docs/migrations/from-drizzle");
  expect(urls).toContain("/docs/ai/skills");
  expect(urls).toContain("/docs/ai/llm");
  expect(urls).not.toContain("/docs/ai/mcp");
  const byFolder = new Map(folders.map((folder) => [folder.name, folder]));
  const operate = byFolder.get("Operate");
  const migrations = byFolder.get("Migrations");
  const queries = byFolder.get("Queries");
  const schema = byFolder.get("Schema");
  const concepts = byFolder.get("Concepts");
  if (
    operate === undefined ||
    migrations === undefined ||
    queries === undefined ||
    schema === undefined ||
    concepts === undefined
  ) {
    throw new Error("missing group");
  }
  const childUrls = (folder: (typeof folders)[number]): string[] =>
    folder.children.flatMap((child) => (child.type === "page" ? [child.url] : []));
  expect(childUrls(concepts)).toEqual([
    "/docs/concepts/how-okmodel-works",
    "/docs/concepts/the-schema-is-the-catalog",
    "/docs/concepts/type-safety-and-inference",
    "/docs/concepts/migrations-and-drift",
    "/docs/concepts/the-safety-model",
    "/docs/concepts/tenant-isolation",
  ]);
  expect(childUrls(operate)).toEqual([
    "/docs/operate/using-okmodel-safely",
    "/docs/operate/production-checklist",
    "/docs/operate/testing",
    "/docs/operate/protected-targets-and-roles",
    "/docs/operate/connect",
    "/docs/operate/target",
    "/docs/operate/drivers",
    "/docs/operate/session-and-pool",
    "/docs/operate/query-limits",
    "/docs/operate/startup-check",
    "/docs/operate/replicas-and-topology",
    "/docs/operate/session-settings",
    "/docs/operate/observability",
    "/docs/operate/errors",
  ]);
  expect(childUrls(schema)).toEqual([
    "/docs/schema/tables",
    "/docs/schema/columns",
    "/docs/schema/text-columns",
    "/docs/schema/number-columns",
    "/docs/schema/time-columns",
    "/docs/schema/binary-json-id-columns",
    "/docs/schema/postgres-specific-columns",
    "/docs/schema/defaults",
    "/docs/schema/the-schema",
    "/docs/schema/keys-and-identity",
    "/docs/schema/references",
    "/docs/schema/relations",
    "/docs/schema/indexes",
    "/docs/schema/checks",
    "/docs/schema/validation",
    "/docs/schema/visibility",
    "/docs/schema/names-and-casing",
    "/docs/schema/traits",
    "/docs/schema/tenancy",
    "/docs/schema/enums-arrays-picklists",
    "/docs/schema/codecs-and-row-types",
    "/docs/schema/required-rows",
    "/docs/schema/views",
    "/docs/schema/functions",
    "/docs/schema/triggers",
    "/docs/schema/extensions",
    "/docs/schema/several-catalogs",
  ]);
  expect(childUrls(queries)).toEqual([
    "/docs/queries",
    "/docs/queries/read-rows",
    "/docs/queries/write-rows",
    "/docs/queries/shape-results",
    "/docs/queries/search-and-trees",
    "/docs/queries/where-operators",
    "/docs/queries/transactions",
    "/docs/queries/typed-raw-sql",
    "/docs/queries/presets",
    "/docs/queries/request-filters",
  ]);
  expect(childUrls(migrations)).toEqual([
    "/docs/migrations/adopt-existing-database",
    "/docs/migrations/from-drizzle",
    "/docs/migrations/checks-and-lint",
    "/docs/migrations/backfill",
    "/docs/migrations/type-change",
    "/docs/migrations/failures",
    "/docs/migrations/environments",
  ]);
});

test("every public page except the landing has a sidebar icon", () => {
  const missing = source
    .getPages()
    .map((page) => page.url)
    .filter((href) => href !== "/docs" && !hasSidebarIcon(href));
  expect(missing).toEqual([]);
});
