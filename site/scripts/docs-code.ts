/**
 * Type-check every `ts` / `tsx` / `typescript` fence on a public handbook
 * page against the built package. A fence opts out only with
 * `no-check="reason"` in its info string. Fences copied from
 * `docs/readme-examples.md` are already executed by the package tests.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { pageContentPath, type MappedPage } from "../lib/docs-map";
import { repoRoot } from "../lib/repo";
import { contentDir, syncDocs } from "./sync-docs";

/** Languages this gate type-checks. */
const CHECKED_LANGS = new Set(["ts", "tsx", "typescript"]);

/** One fence the gate decided not to type-check, with the reason from its meta. */
export interface DocsCodeOptOut {
  /** Handbook content path, such as `guides/quickstart.md`. */
  readonly page: string;
  readonly reason: string;
  /** First non-empty line of the fence. */
  readonly preview: string;
}

/** One TypeScript diagnostic, tied back to the handbook page. */
export interface DocsCodeFailure {
  readonly page: string;
  readonly preview: string;
  readonly message: string;
}

/** Counts and diagnostics from one run. */
export interface DocsCodeReport {
  readonly checked: number;
  readonly optedOut: readonly DocsCodeOptOut[];
  readonly skippedExamples: number;
  readonly failures: readonly DocsCodeFailure[];
}

interface Fence {
  readonly lang: string;
  readonly meta: string;
  readonly body: string;
  readonly fileName: string | undefined;
  readonly preview: string;
}

interface VirtualFile {
  readonly disk: string;
  readonly page: string;
  readonly preview: string;
}

/**
 * Type-check public handbook fences. Builds the package when `dist/` has
 * no declarations. Writes a throwaway project under `.doc-fences/` and
 * deletes it before returning.
 */
export function checkDocsCode(): DocsCodeReport {
  ensureBuilt();
  syncDocs();
  const examples = exampleBodies();
  const optedOut: DocsCodeOptOut[] = [];
  const failures: DocsCodeFailure[] = [];
  const virtual: VirtualFile[] = [];
  const written = new Set<string>();
  let skippedExamples = 0;
  let checked = 0;

  const scratch = join(repoRoot(), ".doc-fences");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  try {
    for (const file of markdownFiles(contentDir)) {
      const raw = readFileSync(file, "utf8");
      const page = relative(contentDir, file);
      const body = stripFrontmatter(raw);
      // Fences from one repository file share a directory, so `./schema.ts`
      // in the README resolves to the schema fence earlier in that file.
      const dir = join(scratch, projectDir(frontmatterField(raw, "source")));
      const used = new Set<string>();
      let anonymous = 0;
      let continuation: { readonly disk: string } | undefined;

      for (const fence of extractFences(body)) {
        if (!CHECKED_LANGS.has(fence.lang)) continue;
        if (examples.has(fence.body.trim())) {
          skippedExamples += 1;
          continue;
        }
        const reason = optOutReason(fence.meta);
        if (reason === "") {
          failures.push({
            page,
            preview: fence.preview,
            message: 'no-check requires a quoted reason, for example no-check="needs a running database"',
          });
          continue;
        }
        if (reason !== undefined) {
          optedOut.push({ page, reason, preview: fence.preview });
          continue;
        }

        const continues =
          fence.fileName === undefined &&
          continuation !== undefined &&
          !/^\s*(import|export)\b/m.test(fence.body);
        if (continues && continuation !== undefined) {
          writeFileSync(continuation.disk, `${readFileSync(continuation.disk, "utf8")}\n${fence.body}\n`);
          checked += 1;
          continue;
        }

        const ext = fence.lang === "tsx" ? ".tsx" : ".ts";
        const preferred =
          fence.fileName ??
          `${page.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}-${String(anonymous).padStart(2, "0")}${ext}`;
        if (fence.fileName === undefined) anonymous += 1;
        const disk = join(dir, preferred);
        if (used.has(preferred) || written.has(disk)) {
          failures.push({
            page,
            preview: fence.preview,
            message: `two fences in this repository file are named ${preferred}`,
          });
          continue;
        }
        used.add(preferred);
        written.add(disk);
        mkdirSync(join(disk, ".."), { recursive: true });
        writeFileSync(disk, fence.body.endsWith("\n") ? fence.body : `${fence.body}\n`);
        virtual.push({ disk, page, preview: fence.preview });
        checked += 1;
        continuation = fence.fileName === undefined ? { disk } : undefined;
      }
    }

    if (virtual.length > 0) {
      failures.push(...typecheck(scratch, virtual));
    }
  } finally {
    if (process.env.DOCS_CODE_KEEP !== "1") {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return { checked, optedOut, skippedExamples, failures };
}

function ensureBuilt(): void {
  const declarations = join(repoRoot(), "dist", "contracts", "index.d.ts");
  if (existsSync(declarations)) return;
  const result = spawnSync("bun", ["run", "build"], {
    cwd: repoRoot(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`bun run build failed before the docs code gate\n${detail}`);
  }
}

function exampleBodies(): Set<string> {
  const raw = readFileSync(join(repoRoot(), "docs", "readme-examples.md"), "utf8");
  const bodies = new Set<string>();
  for (const fence of extractFences(raw)) {
    if (CHECKED_LANGS.has(fence.lang)) bodies.add(fence.body.trim());
  }
  return bodies;
}

/**
 * Opening-fence languages this module understands, plus an optional file
 * name taken from a preceding `` `file.ts`: `` line.
 */
function extractFences(markdown: string): Fence[] {
  const lines = markdown.split("\n");
  const fences: Fence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("```")) continue;
    const info = line.slice(3).trim();
    const lang = info.split(/\s+/)[0] ?? "";
    const meta = lang.length === 0 ? "" : info.slice(lang.length).trim();
    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !(lines[cursor] ?? "").startsWith("```")) {
      body.push(lines[cursor] ?? "");
      cursor += 1;
    }
    if (lang.length > 0) {
      const text = body.join("\n");
      fences.push({
        lang,
        meta,
        body: text,
        fileName: fileNameBefore(lines, index),
        preview: text.trim().split("\n")[0]?.trim() ?? "",
      });
    }
    index = cursor;
  }
  return fences;
}

function fileNameBefore(lines: readonly string[], openAt: number): string | undefined {
  for (let index = openAt - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0) continue;
    const match = /^`([^`]+)`:?$/.exec(line);
    const name = match?.[1];
    if (name === undefined) return undefined;
    if (name.includes("..") || name.startsWith("/") || name.startsWith("\\")) return undefined;
    if (!/^[\w./-]+\.tsx?$/.test(name)) return undefined;
    return name.replace(/^\.\//, "");
  }
  return undefined;
}

/**
 * The quoted `no-check` reason, `""` when the marker is present but empty,
 * or `undefined` when the fence is checked.
 */
function optOutReason(meta: string): string | undefined {
  if (!meta.includes("no-check")) return undefined;
  const match = /(?:^|\s)no-check="([^"]*)"/.exec(meta);
  if (match === null) return "";
  return match[1]?.trim() ?? "";
}

function frontmatterField(raw: string, key: string): string {
  if (!raw.startsWith("---\n")) return "page";
  const end = raw.indexOf("\n---\n");
  if (end < 0) return "page";
  const block = raw.slice(4, end);
  const prefix = `${key}: `;
  for (const line of block.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const value: unknown = JSON.parse(line.slice(prefix.length));
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "page";
}

function projectDir(source: string): string {
  return source.replace(/[^\w.-]+/g, "-");
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---\n");
  if (end < 0) return raw;
  return raw.slice(end + "\n---\n".length);
}

function typecheck(scratch: string, files: readonly VirtualFile[]): DocsCodeFailure[] {
  const configPath = join(scratch, "tsconfig.json");
  const byDisk = new Map(files.map((file) => [file.disk, file]));
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          moduleDetection: "force",
          target: "esnext",
          lib: ["esnext"],
          types: ["bun"],
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          noUnusedLocals: false,
          noUnusedParameters: false,
        },
        files: files.map((file) => relative(scratch, file.disk)),
      },
      null,
      2,
    )}\n`,
  );

  const tsc = join(repoRoot(), "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", configPath, "--pretty", "false", "--noEmit"], {
    cwd: repoRoot(),
    encoding: "utf8",
  });
  if (result.error) {
    return [
      {
        page: "(gate)",
        preview: "",
        message: result.error.message,
      },
    ];
  }
  if (result.status === 0) return [];

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const failures: DocsCodeFailure[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^(.*)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (match === null) continue;
    const reported = match[1] ?? "";
    const disk = isAbsolute(reported) ? reported : resolve(repoRoot(), reported);
    const message = `${match[4] ?? ""}: ${match[5] ?? ""}`;
    const where = match[2] !== undefined && match[3] !== undefined ? `${match[2]}:${match[3]}` : "";
    const file = byDisk.get(disk);
    const key = `${disk}:${where}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({
      page: file?.page ?? relative(scratch, disk),
      preview: file?.preview ?? "",
      message: where.length > 0 ? `${where} ${message}` : message,
    });
  }
  if (failures.length === 0) {
    failures.push({
      page: "(gate)",
      preview: "",
      message: output.trim().slice(0, 2000) || `tsc exited ${String(result.status)}`,
    });
  }
  return failures;
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk(dir);
  return files;
}

/** Page paths the gate reads. Present so a map change cannot drop a page silently. */
export function docsCodePages(pages: readonly MappedPage[]): readonly string[] {
  return pages.map((page) => pageContentPath(page));
}
