/**
 * First-load weight of the prerendered homepage and a docs page.
 *
 * Reads the production HTML Next wrote under `site/.next` and sums the
 * script files that HTML loads. Gzip is level 9, the same compressor the
 * step 1 sample used. Run after `bun run build`. This does not gate the
 * byte goals; it prints them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { siteRoot } from "../lib/repo";

/** One prerendered route. */
interface PageWeight {
  readonly route: string;
  readonly html: number;
  readonly htmlGzip: number;
  readonly js: number;
  readonly jsGzip: number;
  readonly scripts: number;
}

const PAGES: readonly { readonly route: string; readonly html: string }[] = [
  { route: "/", html: "server/app/index.html" },
  { route: "/docs", html: "server/app/docs.html" },
  { route: "/docs/start", html: "server/app/docs/start.html" },
];

/**
 * Measure the prerendered pages. Exits 1 when the build output is missing
 * or a docs page has no heading in the HTML.
 */
function main(): void {
  const nextDir = join(siteRoot(), ".next");
  const rows: PageWeight[] = [];
  for (const page of PAGES) {
    const htmlPath = join(nextDir, page.html);
    if (!existsSync(htmlPath)) {
      process.stderr.write(`missing ${htmlPath}\nrun bun run build in site/ first\n`);
      process.exit(1);
    }
    rows.push(measure(page.route, htmlPath, nextDir));
  }
  const docs = rows.find((row) => row.route === "/docs/start");
  const docsHtml = readFileSync(join(nextDir, "server/app/docs/start.html"), "utf8");
  if (docs !== undefined && !docsHtml.includes("<h1")) {
    process.stderr.write("docs HTML has no h1; the page is not readable without JavaScript\n");
    process.exit(1);
  }
  process.stdout.write(table(rows));
}

/**
 * Sum the script files referenced by one HTML document.
 *
 * @param route - Public path, for the report
 * @param htmlPath - Prerendered HTML
 * @param nextDir - The `.next` directory
 */
function measure(route: string, htmlPath: string, nextDir: string): PageWeight {
  const html = readFileSync(htmlPath);
  const text = html.toString("utf8");
  const sources: string[] = [];
  for (const match of text.matchAll(/<script[^>]+src="([^"]+\.js)"/g)) {
    const src = match[1];
    if (src !== undefined && !sources.includes(src)) sources.push(src);
  }
  let js = 0;
  let jsGzip = 0;
  for (const src of sources) {
    const file = join(nextDir, src.replace(/^\/_next\//, ""));
    const bytes = readFileSync(file);
    js += bytes.byteLength;
    jsGzip += gzipSync(bytes, { level: 9 }).byteLength;
  }
  return {
    route,
    html: html.byteLength,
    htmlGzip: gzipSync(html, { level: 9 }).byteLength,
    js,
    jsGzip,
    scripts: sources.length,
  };
}

/**
 * A plain text table.
 *
 * @param rows - Measured pages
 */
function table(rows: readonly PageWeight[]): string {
  const header = "route\thtml\thtml gzip\tjs\tjs gzip\tscripts";
  const lines = rows.map(
    (row) =>
      `${row.route}\t${String(row.html)}\t${String(row.htmlGzip)}\t${String(row.js)}\t${String(row.jsGzip)}\t${String(row.scripts)}`,
  );
  return `${header}\n${lines.join("\n")}\n`;
}

main();
