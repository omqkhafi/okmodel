/**
 * Search keyboard actions, excerpt rendering, and the client-weight cuts.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { siteRoot } from "./repo";
import { searchKeyAction } from "./search-keys";
import { searchHits, searchSnippet } from "./search-snippet";

test("arrow keys wrap, enter selects, escape closes", () => {
  expect(searchKeyAction("ArrowDown", 1, 3)).toEqual({ type: "move", index: 2 });
  expect(searchKeyAction("ArrowDown", 2, 3)).toEqual({ type: "move", index: 0 });
  expect(searchKeyAction("ArrowUp", 0, 3)).toEqual({ type: "move", index: 2 });
  expect(searchKeyAction("Enter", 1, 3)).toEqual({ type: "select" });
  expect(searchKeyAction("Enter", 0, 0)).toEqual({ type: "none" });
  expect(searchKeyAction("Escape", 0, 3)).toEqual({ type: "close" });
  expect(searchKeyAction("a", 0, 3)).toEqual({ type: "none" });
});

test("excerpts keep mark and drop other tags", () => {
  expect(searchSnippet("see <mark>schema</mark> and <script>no</script>")).toEqual([
    { mark: false, text: "see " },
    { mark: true, text: "schema" },
    { mark: false, text: " and no" },
  ]);
  expect(searchHits("empty")).toEqual([]);
  expect(searchHits([{ id: "a", url: "/docs", content: "catalog" }, { type: "action" }])).toEqual([
    { id: "a", url: "/docs", content: "catalog" },
  ]);
});

test("the client shell does not import the motion library, the icon barrel, or the static search index", () => {
  const banned = ["framer-motion", "lucide-react", "orama-static", "fumadocs-core/content/md"];
  const files = sourceFiles(join(siteRoot(), "components")).concat(sourceFiles(join(siteRoot(), "app")));
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const name of banned) {
      if (text.includes(name)) offenders.push(`${file} imports ${name}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("motion is cut when the reader prefers reduced motion", () => {
  const css = readFileSync(join(siteRoot(), "app/global.css"), "utf8");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain("transition: none");
  const topbar = readFileSync(join(siteRoot(), "components/chrome/topbar.tsx"), "utf8");
  expect(topbar).toContain("motion-reduce:transition-none");
});

/**
 * TypeScript sources under a directory.
 *
 * @param dir - Absolute directory
 */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(path);
  }
  return files;
}
