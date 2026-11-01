/**
 * Framework handbook fences that quote example files must match those files.
 *
 * Pages under site/content/docs/frameworks/ embed titled fences. When the
 * title is a path under the matching examples/<stack>/ tree (or
 * examples/shared/ for shared/schema.ts), the fence body must equal the file.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const frameworks = join(root, "site/content/docs/frameworks");

const pageExample: Record<string, string> = {
  "nextjs.mdx": "nextjs",
  "hono.mdx": "hono",
  "express.mdx": "express",
  "tanstack-start.mdx": "tanstack-start",
  "workers.mdx": "workers-neon",
};

type Fence = { readonly title: string; readonly body: string };

function fences(text: string): Fence[] {
  const found: Fence[] = [];
  const pattern = /```(?:\w+)[^\n]*\btitle="([^"]+)"[^\n]*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    found.push({ title: match[1] ?? "", body: match[2] ?? "" });
  }
  return found;
}

function resolveExampleFile(example: string, title: string): string | undefined {
  if (title.startsWith("shared/")) {
    const shared = join(root, "examples", title);
    return existsSync(shared) ? shared : undefined;
  }
  const under = join(root, "examples", example, title);
  return existsSync(under) ? under : undefined;
}

test("framework page fences match the example files they quote", () => {
  const mismatches: string[] = [];
  let compared = 0;
  for (const name of readdirSync(frameworks).filter((item) => item.endsWith(".mdx"))) {
    const example = pageExample[name];
    if (example === undefined) continue;
    const text = readFileSync(join(frameworks, name), "utf8");
    for (const fence of fences(text)) {
      const file = resolveExampleFile(example, fence.title);
      if (file === undefined) continue;
      compared += 1;
      const expected = readFileSync(file, "utf8");
      if (fence.body !== expected) {
        mismatches.push(`${name} title=${fence.title} !== ${file}`);
      }
    }
  }
  expect(compared).toBeGreaterThan(0);
  expect(mismatches).toEqual([]);
});
