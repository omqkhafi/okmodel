/**
 * Type-check every `ts` / `tsx` / `typescript` fence on a public handbook
 * page against the built package. A fence opts out only with
 * `no-check="reason"` in its info string. Fences copied from
 * `tests/fixtures/readme-examples.md` are already executed by the package tests.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { DOCS_CONTENT_DIR as contentDir } from "../lib/markdown-source";
import { repoRoot } from "../lib/repo";

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
  const examples = exampleBodies();
  const optedOut: DocsCodeOptOut[] = [];
  const failures: DocsCodeFailure[] = [];
  const virtual: VirtualFile[] = [];
  const written = new Set<string>();
  const queued: QueuedFence[] = [];
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
      // Fences from one page share a directory, so `./schema.ts`
      // resolves to the last fence with that name in the page.
      const dir = join(scratch, projectDir(page));
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
        if (fence.fileName === undefined) {
          const disk = join(dir, preferred);
          writeFenceFile(disk, fence.body);
          written.add(disk);
          virtual.push({ disk, page, preview: fence.preview });
          continuation = { disk };
        } else {
          queued.push({ fence, page, dir, preferred });
          continuation = undefined;
        }
        checked += 1;
      }
    }

    writeQueuedFences(queued, virtual, written);
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

/** One titled fence waiting until every same-named fence in its file is known. */
interface QueuedFence {
  readonly fence: Fence;
  readonly page: string;
  readonly dir: string;
  readonly preferred: string;
}

/**
 * Write titled fences. The last fence with a name is the file `./` imports
 * see. Earlier fences with that name sit in `also-*` beside those files.
 * A `./db.ts` import with no fence in this file copies the handbook file that
 * defines it, so Basic Usage can use the client from Let's start. One
 * self-contained file wins. Several self-contained files leave the single
 * file that imports `./schema.ts`.
 *
 * @param queued - Titled fences, in page order
 * @param virtual - Files the typecheck reports against
 * @param written - Disk paths already claimed
 */
function writeQueuedFences(queued: readonly QueuedFence[], virtual: VirtualFile[], written: Set<string>): void {
  const groups = new Map<string, QueuedFence[]>();
  for (const item of queued) {
    const key = `${item.dir}\0${item.preferred}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [item]);
    else list.push(item);
  }

  const canonical = new Map<string, string[]>();
  for (const list of groups.values()) {
    const last = list[list.length - 1];
    if (last === undefined) continue;
    const disk = join(last.dir, last.preferred);
    placeFence(disk, last, virtual, written);
    const named = canonical.get(last.preferred) ?? [];
    named.push(disk);
    canonical.set(last.preferred, named);
    for (let index = 0; index < list.length - 1; index += 1) {
      const earlier = list[index];
      if (earlier === undefined) continue;
      placeFence(join(earlier.dir, `also-${String(index)}`, earlier.preferred), earlier, virtual, written);
    }
  }

  const seen = new Set<string>();
  for (const file of virtual) {
    copyMissingImports(file.disk, canonical, seen);
  }
}

/**
 * Copy a `./` import that this file does not define. A module copied from
 * another page brings the siblings it imports, so `db.ts` keeps its `schema.ts`.
 *
 * @param disk - Fence already written
 * @param canonical - File name to the last fence of that name, per source
 * @param seen - Targets already copied
 * @param origin - Source file this one was copied from, when it was copied
 */
function copyMissingImports(
  disk: string,
  canonical: ReadonlyMap<string, readonly string[]>,
  seen: Set<string>,
  origin?: string,
): void {
  const folder = join(disk, "..");
  const folderName = basename(folder);
  for (const spec of relativeImports(readFileSync(disk, "utf8"))) {
    const name = spec.replace(/^\.\//, "");
    const target = join(folder, name);
    if (existsSync(target) || seen.has(target)) continue;
    const besideOrigin = origin === undefined ? undefined : join(origin, "..", name);
    const parentFile = folderName.startsWith("also-") ? join(folder, "..", name) : undefined;
    const sources = canonical.get(name) ?? [];
    const importsOf = (path: string): readonly string[] => relativeImports(readFileSync(path, "utf8"));
    const selfContained = sources.filter((path) => importsOf(path).length === 0);
    const withSchema = sources.filter((path) => importsOf(path).includes("./schema.ts"));
    const pool =
      selfContained.length === 1
        ? selfContained
        : withSchema.length === 1
          ? withSchema
          : selfContained.length > 0
            ? selfContained
            : sources;
    let source: string | undefined;
    if (besideOrigin !== undefined && existsSync(besideOrigin) && besideOrigin !== target) source = besideOrigin;
    else if (parentFile !== undefined && existsSync(parentFile)) source = parentFile;
    else if (pool.length === 1) source = pool[0];
    if (source === undefined || source === target) continue;
    seen.add(target);
    mkdirSync(folder, { recursive: true });
    writeFileSync(target, readFileSync(source, "utf8"));
    copyMissingImports(target, canonical, seen, source);
  }
}

/**
 * Relative `./` imports outside a comment. The docs gate uses these to find
 * the sibling fence.
 *
 * @param body - Fence source
 */
function relativeImports(body: string): readonly string[] {
  const specs: string[] = [];
  for (const match of body.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

/**
 * Write one fence and remember it for the typecheck report.
 *
 * @param disk - Absolute path under the scratch project
 * @param item - Fence to write
 * @param virtual - Files the typecheck reports against
 * @param written - Disk paths already claimed
 */
function placeFence(disk: string, item: QueuedFence, virtual: VirtualFile[], written: Set<string>): void {
  writeFenceFile(disk, item.fence.body);
  written.add(disk);
  virtual.push({ disk, page: item.page, preview: item.fence.preview });
}

/**
 * Write a fence body, adding a trailing newline when the sample omitted one.
 *
 * @param disk - Absolute path
 * @param body - Fence source
 */
function writeFenceFile(disk: string, body: string): void {
  mkdirSync(join(disk, ".."), { recursive: true });
  writeFileSync(disk, body.endsWith("\n") ? body : `${body}\n`);
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
  const raw = readFileSync(join(repoRoot(), "tests", "fixtures", "readme-examples.md"), "utf8");
  const bodies = new Set<string>();
  for (const fence of extractFences(raw)) {
    if (CHECKED_LANGS.has(fence.lang)) bodies.add(fence.body.trim());
  }
  return bodies;
}

/**
 * Opening-fence languages this module understands. The file name is
 * `title="file.ts"` on the fence, or a preceding `` `file.ts`: `` line.
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
        fileName: fileNameFromMeta(meta) ?? fileNameBefore(lines, index),
        preview: text.trim().split("\n")[0]?.trim() ?? "",
      });
    }
    index = cursor;
  }
  return fences;
}

/**
 * File name from `title="file.ts"` on the opening fence.
 *
 * @param meta - Text after the language on the opening fence
 */
function fileNameFromMeta(meta: string): string | undefined {
  const match = /(?:^|\s)title="([^"]*)"/.exec(meta);
  return sanitizeFenceName(match?.[1]?.trim());
}

function fileNameBefore(lines: readonly string[], openAt: number): string | undefined {
  for (let index = openAt - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0) continue;
    const match = /^`([^`]+)`:?$/.exec(line);
    return sanitizeFenceName(match?.[1]);
  }
  return undefined;
}

/**
 * A fence file name that stays inside the scratch project.
 *
 * @param name - Candidate from a title or a caption line
 */
function sanitizeFenceName(name: string | undefined): string | undefined {
  if (name === undefined || name.length === 0) return undefined;
  if (name.includes("..") || name.startsWith("/") || name.startsWith("\\")) return undefined;
  if (!/^[\w./-]+\.tsx?$/.test(name)) return undefined;
  return name.replace(/^\.\//, "");
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

function projectDir(page: string): string {
  return page.replace(/[^\w.-]+/g, "-");
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

/**
 * Every `.md` and `.mdx` file under a directory.
 *
 * @param dir - Directory to walk
 */
export function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdx"))) files.push(path);
    }
  };
  walk(dir);
  return files;
}
