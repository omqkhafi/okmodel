/**
 * `tsc` text for mistakes, plus the declaration text used in place of hover.
 *
 * Hover cannot be measured without the compiler API (D111). These files are the proxy.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { generateFixture } from "@okmodel/harness/fixtures";

import { runTsc } from "./diagnostics.js";
import { emitDeclarations } from "./emit.js";
import { specifier, writeProjectConfig } from "./projects.js";

const sourceRoot = import.meta.dir;
const repoRoot = join(sourceRoot, "../../../..");

/** One compiler transcript. */
export type Snapshot = {
  readonly name: string;
  readonly text: string;
};

/**
 * Compiles the mistake projects and the declaration display.
 *
 * @returns Normalized compiler text, plus the build step's declaration
 */
export function collectSnapshots(): readonly Snapshot[] {
  const root = join(tmpdir(), `okm-types-snap-${String(Date.now())}`);
  mkdirSync(root, { recursive: true });
  return [
    compile(root, "unknown-table", { "probe.ts": unknownTable }),
    compile(root, "insert-missing", { "probe.ts": insertMissing }),
    compile(root, "insert-type", { "probe.ts": insertType }),
    compile(root, "generated-insert", { "probe.ts": generatedInsert }),
    compile(root, "missing-ref", { "probe.ts": missingRef }),
    compile(root, "duplicate-name", { "probe.ts": duplicateName }),
    compile(root, "register-conflict", {
      "registry.ts": "export interface Register {}\n",
      "left.ts": registerLeft,
      "right.ts": registerRight,
      "probe.ts": 'import "./left.js";\nimport "./right.js";\nexport type Ready = true;\n',
    }),
    compile(root, "import-cycle", { "a.ts": cycleA, "b.ts": cycleB }),
    compile(root, "name-reference", {
      "users.ts": nameUsers,
      "tasks.ts": nameTasks,
      "probe.ts": nameProbe,
    }),
    emittedInsertMissing(root),
    declaration(root),
    {
      name: "emitted-row",
      text: emitDeclarations(oneTable()),
    },
  ];
}

function emittedInsertMissing(root: string): Snapshot {
  const dir = join(root, "emitted-insert-missing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "types.d.ts"), emitDeclarations(oneTable()));
  writeFileSync(
    join(dir, "probe.ts"),
    'import type { Inserts } from "./types.js";\n\nexport const row: Inserts["t000"] = {};\n',
  );
  writeProjectConfig(dir, ["probe.ts"]);
  const ran = runTsc(["--noEmit", "--pretty", "false", "-p", dir], repoRoot);
  return {
    name: "emitted-insert-missing",
    text: transcript(ran.exitCode, normalize(ran.output, dir)),
  };
}

function oneTable() {
  const fixture = generateFixture({ seed: 1, tables: 10 });
  const table = fixture.tables[0];
  if (table === undefined) {
    throw new Error("seed 1 fixture has no tables");
  }
  return { ...fixture, tableCount: 1, tables: [table] };
}

function compile(root: string, name: string, files: Readonly<Record<string, string>>): Snapshot {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const names = Object.keys(files);
  for (const file of names) {
    const body = files[file];
    if (body === undefined) {
      continue;
    }
    writeFileSync(join(dir, file), fill(dir, body));
  }
  writeProjectConfig(dir, names);
  const ran = runTsc(["--noEmit", "--pretty", "false", "-p", dir], repoRoot);
  return { name, text: transcript(ran.exitCode, normalize(ran.output, dir)) };
}

function declaration(root: string): Snapshot {
  const dir = join(root, "display");
  mkdirSync(dir, { recursive: true });
  const subject = join(sourceRoot, "display-subject.ts");
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2023",
          skipLibCheck: true,
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: sourceRoot,
          outDir: dir,
          types: [],
        },
        files: [subject],
      },
      null,
      2,
    )}\n`,
  );
  const ran = runTsc(["-p", join(dir, "tsconfig.json"), "--pretty", "false"], repoRoot);
  if (ran.exitCode !== 0) {
    return { name: "declaration", text: transcript(ran.exitCode, normalize(ran.output, dir)) };
  }
  const emitted = readFileSync(join(dir, "display-subject.d.ts"), "utf8");
  return { name: "declaration", text: transcript(0, normalize(emitted, dir)) };
}

function fill(dir: string, body: string): string {
  return body
    .replaceAll("{{types}}", spec(dir, "index.ts"))
    .replaceAll("{{column}}", spec(dir, "column.ts"))
    .replaceAll("{{table}}", spec(dir, "table.ts"))
    .replaceAll("{{schema}}", spec(dir, "schema.ts"));
}

function spec(dir: string, file: string): string {
  return specifier(dir, join(sourceRoot, file));
}

function normalize(output: string, dir: string): string {
  const fromRepo = relative(repoRoot, dir);
  return output.split(fromRepo).join("<project>").split(dir).join("<project>");
}

function transcript(exitCode: number, text: string): string {
  return `exit ${String(exitCode)}\n${text.trim()}\n`;
}

const unknownTable = `import type { Row } from "{{types}}";
import { appSchema } from "{{types}}";

export type Missing = Row<"missing", typeof appSchema>;
`;

const insertMissing = `import type { Insert } from "{{types}}";

export const row: Insert<"users"> = {};
`;

const insertType = `import type { Insert } from "{{types}}";

export const row: Insert<"users"> = { email: 1 };
`;

const generatedInsert = `import { t } from "{{column}}";
import { table } from "{{table}}";

const item = table("item", {
  id: t.id(),
  title: t.text(),
  rank: t.integer().generated(),
});

export const row: typeof item["~insert"] = { title: "a", rank: 1 };
`;

const missingRef = `import { t } from "{{column}}";
import { schema } from "{{schema}}";
import { table } from "{{table}}";

export const child = schema({
  tables: [table("child", { id: t.id(), parentId: t.uuid().references("nope") })],
});
`;

const duplicateName = `import { t } from "{{column}}";
import { schema } from "{{schema}}";
import { table } from "{{table}}";

const left = table("same", { id: t.id(), name: t.text() });
const right = table("same", { id: t.id(), title: t.integer() });
export const duplicated = schema({ tables: [left, right] });

type RowSame = typeof duplicated["~byName"]["same"]["~row"];
export const probe: { readonly name: string } = null as unknown as RowSame;
`;

const registerLeft = `import { t } from "{{column}}";
import { schema } from "{{schema}}";
import { table } from "{{table}}";

export const left = schema({ tables: [table("left", { id: t.id() })] });

declare module "./registry.js" {
  interface Register {
    readonly schema: typeof left;
  }
}
`;

const registerRight = `import { t } from "{{column}}";
import { schema } from "{{schema}}";
import { table } from "{{table}}";

export const right = schema({
  tables: [table("right", { id: t.id(), name: t.text() })],
});

declare module "./registry.js" {
  interface Register {
    readonly schema: typeof right;
  }
}
`;

const cycleA = `import { b } from "./b.js";
import { t } from "{{column}}";
import { table } from "{{table}}";

export const a = table("a", { id: t.id() });
export const seen = b;
export const wrong: typeof b["~name"] = 1;
`;

const cycleB = `import { a } from "./a.js";
import { t } from "{{column}}";
import { table } from "{{table}}";

export const b = table("b", { id: t.id() });
export const seen = a;
`;

const nameUsers = `import { t } from "{{column}}";
import { table } from "{{table}}";

export const users = table("users", { id: t.id(), email: t.text() });
`;

const nameTasks = `import { t } from "{{column}}";
import { schema } from "{{schema}}";
import { table } from "{{table}}";
import { users } from "./users.js";

export const tasks = table("tasks", {
  id: t.id(),
  ownerId: t.uuid().references("users"),
});

export const app = schema({ tables: [users, tasks] });
`;

const nameProbe = `import { app } from "./tasks.js";

type Refs = typeof app["~missingRefs"];
export const refs: Refs = 0 as never;
`;
