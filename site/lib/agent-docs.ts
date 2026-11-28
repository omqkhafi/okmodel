/**
 * One generator for `llms.txt`, the split `llms-*.txt` files, and the
 * per-page markdown twins.
 *
 * `llms-full.txt` is not produced. A file that cannot be read in one fetch
 * is not a full copy, so there is no dump and no shim.
 */

import { ERROR_FIXES } from "./generated/error-fixes";
import { handbookPages, type HandbookPage } from "./handbook-corpus";
import { absoluteDocsUrl, markdownPathForHref, markdownPathForSlugs } from "./markdown-url";
import { readTagline, siteSameAs } from "./package-meta";
import { orderedHandbookUrls } from "./page-chrome";
import { SITE_NAME } from "./site-identity";
import { withMarkdownTwinIndex } from "./source";
import { DOCS_TASKS } from "./tasks";

/** A section file must fit in one fetch. */
export const AGENT_FILE_CHAR_LIMIT = 100_000;

/** Approximate tokens as characters / 4. */
export function approximateTokens(characters: number): number {
  return Math.round(characters / 4);
}

/** One generated agent file. */
export type AgentFile = {
  readonly name: string;
  readonly body: string;
  readonly characters: number;
  readonly tokens: number;
};

/**
 * Queries an agent needs before the rest of that section. The full section
 * still has its own file.
 */
export const QUERY_ESSENTIAL_URLS: readonly string[] = [
  "/docs/queries",
  "/docs/queries/read-rows",
  "/docs/queries/write-rows",
  "/docs/queries/where-operators",
  "/docs/queries/transactions",
];

const CORE_SECTIONS = new Set(["start", "concepts"]);

let pageCache: Map<string, string> | undefined;
let fileCache: readonly AgentFile[] | undefined;

/**
 * Markdown twin for one handbook page.
 *
 * @param url - HTML path, such as `/docs/schema/tables`
 */
export function renderPageMarkdown(url: string): string {
  const cached = pageDocuments().get(url);
  if (cached === undefined) throw new Error(`no handbook page for ${url}`);
  return cached;
}

/**
 * `llms.txt` in the llmstxt.org shape. Links are absolute markdown URLs.
 * The Optional section lists every split file.
 */
export function buildLlmsTxt(): string {
  const pages = orderedPages();
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const lines: string[] = [
    `# ${SITE_NAME}`,
    "",
    `> ${oneLine(readTagline())}`,
    "",
    "Each link is the markdown for that page. Fetch one Optional file to read a section whole.",
    "",
  ];

  const treeUrls = orderedHandbookUrls();
  const rootUrls = treeUrls.filter((url) => byUrl.get(url)?.sectionSlug === "handbook");
  pushSection(lines, "Handbook", rootUrls, byUrl);

  const seen = new Set<string>();
  for (const page of pages) {
    if (page.sectionSlug === "handbook" || seen.has(page.sectionSlug)) continue;
    seen.add(page.sectionSlug);
    const urls = pages.filter((item) => item.sectionSlug === page.sectionSlug).map((item) => item.url);
    pushSection(lines, page.section, urls, byUrl);
  }

  lines.push("## Optional", "");
  for (const file of agentFiles()) {
    lines.push(linkLine(file.name, absoluteDocsUrl(`/${file.name}`), fileSummary(file.name)));
  }
  lines.push(linkLine("Changelog", absoluteDocsUrl("/changelog"), "Published releases."));
  for (const url of siteSameAs()) {
    const title = url.includes("github.com") ? "GitHub" : SITE_NAME;
    lines.push(linkLine(title, url, "Project home."));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Split agent files. Each one is under {@link AGENT_FILE_CHAR_LIMIT}.
 */
export function agentFiles(): readonly AgentFile[] {
  fileCache ??= createAgentFiles();
  return fileCache;
}

/**
 * One split file by its URL name (`llms-core.txt`), or `undefined`.
 *
 * @param name - File name, including `.txt`
 */
export function agentFile(name: string): AgentFile | undefined {
  return agentFiles().find((file) => file.name === name);
}

/**
 * JSON catalogue. `files` replaces the old full-dump pointer.
 */
export function buildLlmsCatalog(): {
  readonly name: string;
  readonly description: string;
  readonly origin: string;
  readonly index: string;
  readonly files: readonly { readonly name: string; readonly url: string; readonly characters: number }[];
  readonly pages: readonly {
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly html: string;
    readonly markdown: string;
  }[];
} {
  const origin = absoluteDocsUrl("/").replace(/\/$/, "");
  const pages = handbookPages().slice().sort((a, b) => a.url.localeCompare(b.url));
  return {
    name: SITE_NAME,
    description: oneLine(readTagline()),
    origin,
    index: absoluteDocsUrl("/llms.txt"),
    files: agentFiles().map((file) => ({
      name: file.name,
      url: absoluteDocsUrl(`/${file.name}`),
      characters: file.characters,
    })),
    pages: pages.map((page) => ({
      slug: page.slugs.join("/"),
      title: page.title,
      description: oneLine(page.summary || page.description),
      html: absoluteDocsUrl(page.url),
      markdown: absoluteDocsUrl(markdownPathForSlugs(page.slugs)),
    })),
  };
}

/**
 * Rewrite handbook links to absolute markdown URLs. Fenced code is unchanged.
 *
 * @param markdown - Page or bundle body
 * @param origin - Absolute origin
 */
export function rewriteDocLinks(markdown: string, origin: string = absoluteDocsUrl("/").replace(/\/$/, "")): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let fence = false;
  return lines
    .map((line) => {
      if (line.startsWith("```")) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      return line.replace(/\]\((\/[^)\s]+)\)/g, (full, href: string) => {
        if (href.startsWith("/docs")) return `](${absoluteDocsUrl(markdownPathForHref(href), origin)})`;
        if (href.startsWith("/changelog") || href.startsWith("/llms")) return `](${absoluteDocsUrl(href, origin)})`;
        return full;
      });
    })
    .join("\n");
}

/**
 * Give a bare fence the `text` language. Fences that already have one stay.
 *
 * @param markdown - Page body
 */
export function ensureFenceLanguages(markdown: string): string {
  const lines = markdown.split("\n");
  let open = false;
  return lines
    .map((line) => {
      if (!line.startsWith("```")) return line;
      if (open) {
        open = false;
        return line;
      }
      open = true;
      return line.slice(3).trim().length === 0 ? "```text" : line;
    })
    .join("\n");
}

/**
 * Render every page once.
 */
function pageDocuments(): Map<string, string> {
  if (pageCache !== undefined) return pageCache;
  const fixes = errorFixAppendix();
  const map = new Map<string, string>();
  for (const page of handbookPages()) {
    const extra = page.url === "/docs/reference/errors" ? fixes : "";
    map.set(page.url, pageDocument(page, extra));
  }
  pageCache = map;
  return map;
}

/**
 * Pages in sidebar order.
 */
function orderedPages(): readonly HandbookPage[] {
  const byUrl = new Map(handbookPages().map((page) => [page.url, page]));
  const ordered = orderedHandbookUrls().flatMap((url) => {
    const page = byUrl.get(url);
    return page === undefined ? [] : [page];
  });
  const seen = new Set(ordered.map((page) => page.url));
  return [...ordered, ...handbookPages().filter((page) => !seen.has(page.url))];
}

/**
 * Core file plus one file per top-level section, split when a file is too long.
 */
function createAgentFiles(): readonly AgentFile[] {
  const pages = orderedPages();
  const core = pages.filter(
    (page) => page.sectionSlug === "handbook" || CORE_SECTIONS.has(page.sectionSlug) || QUERY_ESSENTIAL_URLS.includes(page.url),
  );
  const files: AgentFile[] = [];
  files.push(
    ...pack("core", "OKModel", "Get started, concepts, the query calls you use first, and the task index.", core, true),
  );
  const seen = new Set<string>();
  for (const page of pages) {
    if (page.sectionSlug === "handbook" || seen.has(page.sectionSlug)) continue;
    seen.add(page.sectionSlug);
    const group = pages.filter((item) => item.sectionSlug === page.sectionSlug);
    files.push(...pack(page.sectionSlug, page.section, `${page.section} pages.`, group, false));
  }
  return files;
}

/**
 * Pack pages into one or more files under the character limit.
 *
 * @param slug - File slug (`core`, `schema`)
 * @param title - H1
 * @param summary - Blockquote
 * @param pages - Pages in order
 * @param core - Whether to lead with the task index
 */
function pack(
  slug: string,
  title: string,
  summary: string,
  pages: readonly HandbookPage[],
  core: boolean,
): AgentFile[] {
  const pieces = pagePieces(pages);
  const groups = chunkPieces(pieces, core);
  const bodies: string[] = [];
  const emit = (group: readonly string[], withTasks: boolean): void => {
    const body = renderBundle(title, summary, group, withTasks);
    if (body.length > AGENT_FILE_CHAR_LIMIT && group.length > 1) {
      const mid = Math.ceil(group.length / 2);
      emit(group.slice(0, mid), withTasks);
      emit(group.slice(mid), false);
      return;
    }
    bodies.push(body);
  };
  groups.forEach((group, index) => {
    emit(group, core && index === 0);
  });
  return bodies.map((body, index) => {
    const name = bodies.length === 1 ? `llms-${slug}.txt` : `llms-${slug}-${String(index + 1)}.txt`;
    return { name, body, characters: body.length, tokens: approximateTokens(body.length) };
  });
}

/**
 * Page documents, split when one page is longer than a file may be.
 *
 * @param pages - Pages in order
 */
function pagePieces(pages: readonly HandbookPage[]): string[] {
  const documents = pageDocuments();
  const budget = AGENT_FILE_CHAR_LIMIT - 1_000;
  const pieces: string[] = [];
  for (const page of pages) {
    const document = documents.get(page.url);
    if (document === undefined) continue;
    pieces.push(...splitDocument(document, budget));
  }
  return pieces;
}

/**
 * Split one page document on line boundaries. Later parts repeat the source
 * line and the table header so a part still reads on its own.
 *
 * @param document - Rendered page markdown
 * @param limit - Maximum characters for one part
 */
function splitDocument(document: string, limit: number): string[] {
  if (document.length <= limit) return [document];
  const packLimit = Math.max(1_000, limit - 400);
  const lines = document.split("\n");
  const source = lines[0]?.startsWith("Source: ") === true ? lines[0] : "";
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(`${current.join("\n").trimEnd()}\n`);
    current = [];
    size = 0;
  };
  for (const line of lines) {
    const next = size + line.length + 1;
    if (current.length > 0 && next > packLimit) flush();
    if (line.length > packLimit) {
      flush();
      for (let at = 0; at < line.length; at += packLimit) chunks.push(`${line.slice(at, at + packLimit)}\n`);
      continue;
    }
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const preface = [source.length > 0 ? `${source} (continued)` : "Continued.", "", tableHeader(chunks[index - 1] ?? "")]
      .filter((line) => line.length > 0)
      .join("\n");
    return `${preface}\n${chunk}`;
  });
}

/**
 * The last markdown table header in a chunk, including its separator row.
 *
 * @param chunk - Previous part
 */
function tableHeader(chunk: string): string {
  const lines = chunk.split("\n");
  let header = "";
  for (let index = 1; index < lines.length; index += 1) {
    const separator = lines[index] ?? "";
    const previous = lines[index - 1] ?? "";
    const cells = separator.trim();
    if (previous.startsWith("|") && cells.startsWith("|") && cells.includes("-") && /^[\s|:-]+$/.test(cells)) {
      header = `${previous}\n${separator}`;
    }
  }
  return header;
}

/**
 * Group pieces so each rendered bundle stays under the limit.
 *
 * @param pieces - Page parts in order
 * @param core - The first chunk includes the task index
 */
function chunkPieces(pieces: readonly string[], core: boolean): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = bundleOverhead(core);
  for (const piece of pieces) {
    const pieceSize = piece.length + 2;
    if (current.length > 0 && size + pieceSize > AGENT_FILE_CHAR_LIMIT) {
      chunks.push(current);
      current = [];
      size = bundleOverhead(false);
    }
    current.push(piece);
    size += pieceSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Characters used by the bundle heading before any page.
 *
 * @param core - Include the task index
 */
function bundleOverhead(core: boolean): number {
  return 200 + (core ? taskIndex().length : 0);
}

/**
 * One bundle body.
 *
 * @param title - H1
 * @param summary - Blockquote
 * @param pages - Pages in this chunk
 * @param withTasks - Lead with the task index
 */
function renderBundle(title: string, summary: string, pieces: readonly string[], withTasks: boolean): string {
  const parts = [`# ${title}`, "", `> ${oneLine(summary)}`, ""];
  if (withTasks) parts.push(taskIndex(), "");
  for (const piece of pieces) parts.push(piece.trimEnd(), "");
  return `${parts.join("\n").trim()}\n`;
}

/**
 * "I want to…" index, read from the task list.
 */
function taskIndex(): string {
  const byUrl = new Map(handbookPages().map((page) => [page.url, page]));
  const lines = ["## I want to…", ""];
  for (const task of DOCS_TASKS) {
    const path = task.href.split("#")[0] ?? task.href;
    const hash = task.href.includes("#") ? task.href.slice(task.href.indexOf("#")) : "";
    const page = byUrl.get(path);
    const label = page?.title ?? path;
    const href = absoluteDocsUrl(`${markdownPathForHref(path)}${hash}`);
    lines.push(linkLine(label, href, oneLine(task.task)));
  }
  return lines.join("\n");
}

/**
 * Page markdown: source URL, title, summary, chip, body, then fixes.
 *
 * @param page - Handbook page
 * @param extra - Appendix, used for registry fixes
 */
function pageDocument(page: HandbookPage, extra: string): string {
  const summary = oneLine(page.summary || page.description);
  const parts = [`Source: ${absoluteDocsUrl(page.url)}`, "", `# ${page.title}`, "", `> ${summary}`, ""];
  if (page.chip.length > 0) parts.push(page.chip, "");
  parts.push(rewriteDocLinks(ensureFenceLanguages(page.body)).trim(), "");
  if (extra.length > 0) parts.push(extra.trim(), "");
  return withMarkdownTwinIndex(parts.join("\n"));
}

/**
 * Fix text for every registry code. The errors page markdown carries this.
 */
function errorFixAppendix(): string {
  const lines = ["## Registry fixes", ""];
  for (const doc of ERROR_FIXES) {
    lines.push(`### ${doc.code}`, "", doc.fix, "");
  }
  return lines.join("\n");
}

/**
 * One H2 and its links. A section with no pages is omitted.
 *
 * @param lines - Output lines
 * @param heading - Section title
 * @param urls - Page URLs in order
 * @param byUrl - Pages by URL
 */
function pushSection(
  lines: string[],
  heading: string,
  urls: readonly string[],
  byUrl: ReadonlyMap<string, HandbookPage>,
): void {
  const items = urls.flatMap((url) => {
    const page = byUrl.get(url);
    return page === undefined ? [] : [page];
  });
  if (items.length === 0 || heading.trim().length === 0) return;
  lines.push(`## ${heading}`, "");
  for (const page of items) {
    lines.push(
      linkLine(
        page.title,
        absoluteDocsUrl(markdownPathForSlugs(page.slugs)),
        oneLine(page.summary || page.description) || "Handbook page.",
      ),
    );
  }
  lines.push("");
}

/**
 * One-line description of a split file, for the Optional section.
 *
 * @param name - File name
 */
function fileSummary(name: string): string {
  if (name.startsWith("llms-core")) return "Get started, concepts, query essentials, and the task index.";
  const slug = name.replace(/^llms-/, "").replace(/-\d+\.txt$/, "").replace(/\.txt$/, "");
  const page = handbookPages().find((item) => item.sectionSlug === slug);
  return page === undefined ? "Handbook pages." : `${page.section} pages.`;
}

/**
 * One markdown link, with a description when there is one.
 *
 * @param title - Link text
 * @param href - Absolute URL
 * @param note - One-line description
 */
function linkLine(title: string, href: string, note: string): string {
  return note.length > 0 ? `- [${title}](${href}): ${note}` : `- [${title}](${href})`;
}

/**
 * Collapse whitespace to one line.
 *
 * @param value - Source text
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
