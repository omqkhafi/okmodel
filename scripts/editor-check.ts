/**
 * Hover, completion, and diagnostic check through the TypeScript language server.
 *
 * TypeScript 7 ships `tsc` and no `tsserver`. This script spawns the TypeScript 6
 * server at `typescript-editor` over stdio. It does not import the compiler.
 * The server is a dev tool and is not part of a bundle.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRowTypes } from "../src/dialects/pg/emit.js";
import { enumColumn } from "../src/dialects/pg/enum.js";
import { id, integer, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

const FIXTURE = "tests/fixtures/editor/surface.ts";
const CHECKED = "tests/fixtures/editor/surface.editor.ts";
const SNAPSHOT = "tests/fixtures/editor/surface.snap.txt";

type ServerMessage = {
  readonly type?: string;
  readonly request_seq?: number;
  readonly success?: boolean;
  readonly message?: string;
  readonly body?: unknown;
};

/**
 * Compares language-server hover, completions, and diagnostics with the snapshot.
 *
 * @param root - Repository root
 * @param write - When true, replace the snapshot instead of comparing it
 * @returns Problem lines. Empty when the fixture matches
 */
export async function editorCheck(root: string, write: boolean): Promise<readonly string[]> {
  const server = join(root, "node_modules/typescript-editor/lib/tsserver.js");
  const file = join(root, CHECKED);
  let prepared: Prepared;
  try {
    prepared = prepare(readFileSync(join(root, FIXTURE), "utf8"));
  } catch (error) {
    return [`editor-check: cannot read ${FIXTURE}: ${messageOf(error)}`];
  }
  writeFileSync(file, prepared.source);
  const session = new Session(server, root);
  try {
    await session.open();
    const report = await collect(session, file, prepared);
    const problems = [...assertSurface(report), ...(await emittedSurface(server))];
    const rendered = render(report);
    const snapPath = join(root, SNAPSHOT);
    if (write) {
      writeFileSync(snapPath, rendered);
      return problems;
    }
    let expected: string;
    try {
      expected = readFileSync(snapPath, "utf8");
    } catch (error) {
      return [...problems, `editor-check: cannot read ${SNAPSHOT}: ${messageOf(error)}`];
    }
    if (expected !== rendered) {
      return [
        ...problems,
        `editor-check: ${SNAPSHOT} differs. Run bun ./scripts/editor-check.ts --write after reviewing the fixture.`,
      ];
    }
    return problems;
  } catch (error) {
    return [`editor-check: ${messageOf(error)}`];
  } finally {
    session.close();
    rmSync(file, { force: true });
  }
}

type Report = {
  readonly hovers: readonly { readonly name: string; readonly display: string }[];
  readonly completions: readonly { readonly name: string; readonly names: readonly string[] }[];
  readonly diagnostics: readonly string[];
};

type Site = { readonly name: string; readonly index: number };

type Prepared = {
  readonly source: string;
  readonly hovers: readonly Site[];
  readonly completions: readonly Site[];
};

function prepare(text: string): Prepared {
  const parts: string[] = [];
  const hovers: Site[] = [];
  const completions: Site[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\/\*@(hover|complete|diagnostic)\s+(\w+)\*\//g)) {
    const start = match.index;
    parts.push(text.slice(cursor, start));
    const at = parts.join("").length;
    const kind = match[1];
    const name = match[2] ?? "";
    if (kind === "hover") {
      const index = parts.join("").lastIndexOf(name);
      if (index < 0) throw new Error(`editor-check: ${name} is not before its hover marker`);
      hovers.push({ name, index });
    } else if (kind === "complete") {
      completions.push({ name, index: at });
    }
    cursor = start + match[0].length;
  }
  parts.push(text.slice(cursor));
  return { source: parts.join(""), hovers, completions };
}

async function collect(session: Session, file: string, prepared: Prepared): Promise<Report> {
  await session.request("open", { file });
  const hovers: { name: string; display: string }[] = [];
  for (const site of prepared.hovers) {
    const body = await session.request("quickinfo", {
      file,
      ...positionAt(prepared.source, site.index),
    });
    hovers.push({ name: site.name, display: displayOf(body) });
  }
  const completions: { name: string; names: string[] }[] = [];
  for (const site of prepared.completions) {
    const at = positionAt(prepared.source, site.index + 1);
    let body: unknown;
    try {
      body = await session.request("completionInfo", {
        file,
        ...at,
        prefix: "",
        includeExternalModuleExports: false,
      });
    } catch (error) {
      throw new Error(
        `${site.name} at ${String(at.line)}:${String(at.offset)}: ${messageOf(error)}`,
      );
    }
    completions.push({ name: site.name, names: completionNames(body) });
  }
  const body = await session.request("semanticDiagnosticsSync", { file });
  return { hovers, completions, diagnostics: diagnosticTexts(body) };
}

const EMITTED_SURFACE = `
import type { Users, UsersInsert, UsersUpdate } from "./types.js";

export function read(row: Users): { readonly email: string; readonly status: Users["status"] } {
  const rows /*@hover rows*/ = { email: row.email, status: row.status };
  return rows;
}

export function write(input: UsersInsert): UsersInsert {
  const created /*@hover created*/ = { email: input.email, status: input.status };
  return { /*@complete insert*/ email: created.email };
}

export function edit(): UsersUpdate {
  return { /*@complete set*/ email: "a@b.c" };
}

export function bad(row: Users): unknown {
  return row.missing;
}
`;

/**
 * Hover, completion, and diagnostics on the `.d.ts` text `okm build` writes.
 *
 * The file is {@link emitRowTypes} of a schema that includes an enum column.
 *
 * @param server - Path to `tsserver.js`
 * @returns Problem lines. Empty when the emitted rows read like inferred rows
 */
async function emittedSurface(server: string): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), "okm-emitted-"));
  const users = table("users", {
    id: id(),
    email: text(),
    city: text().nullable(),
    role: text().guarded(),
    status: enumColumn("user_status", ["active", "invited"]),
  });
  const tasks = table("tasks", {
    id: id(),
    ownerId: uuid(),
    title: text(),
    position: integer(),
  });
  const built = schema({ tables: [users, tasks] });
  writeFileSync(join(dir, "types.d.ts"), emitRowTypes(built));
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2023",
        noEmit: true,
        types: [],
      },
      files: ["surface.ts"],
    })}\n`,
  );
  let prepared: Prepared;
  try {
    prepared = prepare(EMITTED_SURFACE);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    return [`editor-check: emitted fixture: ${messageOf(error)}`];
  }
  const file = join(dir, "surface.ts");
  writeFileSync(file, prepared.source);
  const session = new Session(server, dir);
  try {
    await session.open();
    const report = await collect(session, file, prepared);
    return assertEmitted(report);
  } catch (error) {
    return [`editor-check: emitted types: ${messageOf(error)}`];
  } finally {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertEmitted(report: Report): readonly string[] {
  const problems: string[] = [];
  const hover = (name: string): string =>
    report.hovers.find((item) => item.name === name)?.display ?? "";
  const names = (name: string): readonly string[] =>
    report.completions.find((item) => item.name === name)?.names ?? [];
  const rows = hover("rows");
  if (!rows.includes("email") || !rows.includes("active") || !rows.includes("invited")) {
    problems.push("editor-check: emitted hover does not show the row fields or the enum labels");
  }
  if (rows.includes("ColumnBuilder")) {
    problems.push("editor-check: emitted hover shows a column builder");
  }
  const created = hover("created");
  if (
    !created.includes("email") ||
    !created.includes("active") ||
    created.includes("ColumnBuilder")
  ) {
    problems.push("editor-check: emitted insert hover does not show the row fields");
  }
  const insert = names("insert");
  if (!insert.includes("email") || !insert.includes("city") || !insert.includes("status")) {
    problems.push(
      `editor-check: emitted insert completions are missing a column (${insert.join(" ")})`,
    );
  }
  if (insert.includes("role") || insert.includes("id")) {
    problems.push("editor-check: emitted insert completions include a column that insert omits");
  }
  const set = names("set");
  if (!set.includes("email") || !set.includes("status")) {
    problems.push("editor-check: emitted update completions are missing a column");
  }
  if (!report.diagnostics.join("\n").includes("missing")) {
    problems.push("editor-check: emitted diagnostics do not name the missing column");
  }
  return problems;
}

function assertSurface(report: Report): readonly string[] {
  const problems: string[] = [];
  const hover = (name: string): string =>
    report.hovers.find((item) => item.name === name)?.display ?? "";
  const names = (name: string): readonly string[] =>
    report.completions.find((item) => item.name === name)?.names ?? [];
  if (!hover("rows").includes("email") || hover("rows").includes("ColumnBuilder")) {
    problems.push("editor-check: hover on rows does not show the email field");
  }
  if (!hover("created").includes("email") || hover("created").includes("ColumnBuilder")) {
    problems.push("editor-check: hover on created does not show the email field");
  }
  const where = names("where");
  if (!where.includes("email") || !where.includes("name")) {
    problems.push("editor-check: where completions are missing a column name");
  }
  const insert = names("insert");
  if (!insert.includes("email") || !insert.includes("city")) {
    problems.push("editor-check: insert completions do not list the insertable columns");
  }
  if (insert.includes("role") || insert.includes("id")) {
    problems.push("editor-check: insert completions include a column that insert omits");
  }
  if (hover("created").includes("[]")) {
    problems.push("editor-check: insert result collapsed to an array");
  }
  const set = names("set");
  if (!set.includes("title") || !set.includes("position")) {
    problems.push("editor-check: update set completions are missing a column name");
  }
  const joined = report.diagnostics.join("\n");
  if (!joined.includes("missing")) {
    problems.push("editor-check: diagnostics do not name the missing column or table");
  }
  return problems;
}

function render(report: Report): string {
  const lines: string[] = [];
  for (const hover of report.hovers) {
    lines.push(`hover ${hover.name}`);
    lines.push(hover.display);
    lines.push("");
  }
  for (const site of report.completions) {
    lines.push(`complete ${site.name}`);
    lines.push(site.names.join(" "));
    lines.push("");
  }
  lines.push("diagnostics");
  for (const text of report.diagnostics) lines.push(text);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function positionAt(text: string, index: number): { line: number; offset: number } {
  let line = 1;
  let start = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "\n") {
      line += 1;
      start = cursor + 1;
    }
  }
  return { line, offset: index - start + 1 };
}

function displayOf(body: unknown): string {
  if (typeof body !== "object" || body === null || !("displayString" in body)) return "";
  const display = body.displayString;
  return typeof display === "string" ? display.replaceAll(/\s+/g, " ").trim() : "";
}

function completionNames(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("entries" in body)) return [];
  const entries = body.entries;
  if (!Array.isArray(entries)) return [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("name" in entry) || !("kind" in entry)) {
      continue;
    }
    if (entry.kind !== "property" && entry.kind !== "method" && entry.kind !== "var") continue;
    if (typeof entry.name === "string") names.push(entry.name);
  }
  names.sort();
  return names;
}

function diagnosticTexts(body: unknown): string[] {
  const list = Array.isArray(body) ? body : [];
  const texts: string[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || !("text" in item)) continue;
    const text = item.text;
    if (typeof text === "string") texts.push(text.replaceAll(/\s+/g, " ").trim());
  }
  texts.sort();
  return texts;
}

class Session {
  readonly #process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Buffer = Buffer.alloc(0);
  #seq = 1;

  constructor(server: string, root: string) {
    this.#process = Bun.spawn(["node", server], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#reader = this.#process.stdout.getReader();
  }

  async open(): Promise<void> {
    await this.request("configure", {
      preferences: { includeCompletionsForModuleExports: false },
    });
  }

  async request(command: string, args: object): Promise<unknown> {
    const seq = this.#seq;
    this.#seq += 1;
    const json = JSON.stringify({ seq, type: "request", command, arguments: args });
    // TypeScript 6 reads one JSON request per line. Responses stay Content-Length frames.
    await this.#process.stdin.write(`${json}\n`);
    await this.#process.stdin.flush();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const message = await this.#read(deadline);
      if (message.type === "response" && message.request_seq === seq) {
        if (message.success === false) {
          throw new Error(`${command} failed: ${message.message ?? "unknown"}`);
        }
        return message.body;
      }
    }
    throw new Error(`${command} timed out`);
  }

  close(): void {
    this.#process.kill();
  }

  async #read(deadline: number): Promise<ServerMessage> {
    while (Date.now() < deadline) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const header = this.#buffer.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length: (\d+)/.exec(header);
        const length = match?.[1] === undefined ? undefined : Number(match[1]);
        if (length === undefined) throw new Error("tsserver message has no Content-Length");
        const start = headerEnd + 4;
        if (this.#buffer.length >= start + length) {
          const json = this.#buffer.subarray(start, start + length).toString("utf8");
          this.#buffer = this.#buffer.subarray(start + length);
          return JSON.parse(json) as ServerMessage;
        }
      }
      const chunk = await readChunk(this.#reader, deadline);
      if (chunk.byteLength === 0) throw new Error("tsserver closed");
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
    }
    throw new Error("tsserver timed out");
  }
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        reject(new Error("tsserver timed out"));
      },
      Math.max(deadline - Date.now(), 0),
    );
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result.done ? Buffer.alloc(0) : Buffer.from(result.value));
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("tsserver read failed"));
      },
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const problems = await editorCheck(repoRoot(), write);
  exitOnProblems(problems);
}
