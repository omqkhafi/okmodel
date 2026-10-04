/**
 * The typed validation surface is present with `okmodel/validate` and absent without it.
 *
 * Each program is compiled on its own, because a module augmentation is global
 * to the program that includes it. The repository program includes
 * `okmodel/validate`, so `tests/validate.test-d.ts` covers the present side and
 * this file covers the side that cannot share a program with it.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { repoRoot } from "../scripts/root.js";

const root = repoRoot();
// Inside node_modules so the program resolves `@types/bun` the way the repository does.
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, "okm-validate-surface-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function spec(dir: string, entry: string): string {
  const path = relative(dir, join(root, "src", `${entry}.ts`)).replaceAll("\\", "/");
  return (path.startsWith(".") ? path : `./${path}`).replace(/\.ts$/, ".js");
}

function compile(name: string, body: (specifier: (entry: string) => string) => string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "probe.ts"),
    body((entry) => spec(dir, entry)),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2023",
        skipLibCheck: true,
        noEmit: true,
        types: ["bun"],
      },
      files: ["probe.ts"],
    }),
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "--pretty", "false", "-p", dir], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${proc.exitCode === 0 ? "ok" : "error"}\n${proc.stdout.toString()}${proc.stderr.toString()}`;
}

const tables = (pg: string): string => `
import { schema, table, text, uuid } from "${pg}";
const tasks = table("tasks", { id: uuid(), title: text() }, { validation: true });
const plain = table("notes", { id: uuid(), body: text() });
export const app = schema({ tables: [tasks, plain], validation: true });
`;

test("without the import, the members are not on the table type", () => {
  const output = compile(
    "without",
    (s) => `${tables(s("dialects/pg/index"))}
import type { Connected } from "${s("runtime/types")}";

export function use(db: Connected<typeof app>) {
  // @ts-expect-error insert.validate is added by okmodel/validate
  db.tasks.insert.validate({ id: "a", title: "b" });
  // @ts-expect-error insert.check is added by okmodel/validate
  db.tasks.insert.check({});
  // @ts-expect-error insert.pick is added by okmodel/validate
  db.tasks.insert.pick("title");
  // @ts-expect-error insert.omit is added by okmodel/validate
  db.tasks.insert.omit("title");
  // @ts-expect-error the Standard Schema member is added by okmodel/validate
  db.tasks.insert["~standard"];
  // @ts-expect-error update.validate is added by okmodel/validate
  db.tasks.update.validate({ title: "x" });
}
`,
  );
  expect(output).toBe("ok\n");
});

test("with the import, the members follow the effective setting", () => {
  const output = compile(
    "with",
    (s) => `import "${s("runtime/validate/index")}";
${tables(s("dialects/pg/index"))}
import type { Connected } from "${s("runtime/types")}";

export async function use(db: Connected<typeof app>) {
  const body = await db.tasks.insert.validate({ id: "a", title: "b" });
  await db.tasks.insert({ id: body.id, title: body.title });
  await db.tasks.insert.check({});
  await db.tasks.insert.pick("title").validate({ title: "b" });
  await db.tasks.insert.omit("id").validate({ title: "b" });
  const standard: "okmodel" = db.tasks.insert["~standard"].vendor;
  await db.tasks.update.validate({ title: "x" });
  return standard;
}
`,
  );
  expect(output).toBe("ok\n");
});

test("with the import, a table that has validation off still has no members", () => {
  const output = compile(
    "off",
    (s) => `import "${s("runtime/validate/index")}";
import { schema, table, text, uuid } from "${s("dialects/pg/index")}";
import type { Connected } from "${s("runtime/types")}";
const tasks = table("tasks", { id: uuid(), title: text() }, { validation: false });
const notes = table("notes", { id: uuid(), body: text() }, { validation: { enabled: true } });
const app = schema({ tables: [tasks, notes], validation: true });

export function use(db: Connected<typeof app>) {
  // @ts-expect-error this table opts out
  db.tasks.insert.validate({ id: "a", title: "b" });
  return db.notes.insert.check({});
}
`,
  );
  expect(output).toBe("ok\n");
});
