import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Lists `.ts` and `.tsx` files under `root`, skipping declaration files.
 */
export function listTypeScriptFiles(root: string): readonly string[] {
  const files: string[] = [];
  walk(root, files);
  return files;
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
      continue;
    }
    if (entry.isFile() && isTypeScriptFile(entry.name)) {
      files.push(path);
    }
  }
}

function isTypeScriptFile(name: string): boolean {
  return (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts");
}
