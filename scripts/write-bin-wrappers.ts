/**
 * Writes the `okm` and `okmodel` bin wrappers into `dist/`.
 *
 * Each file is a shebang plus `import "./tooling/cli.js"`. The bins are separate
 * files because `bun pm pack` lists a file twice when both point at one file.
 */

import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const wrapper = '#!/usr/bin/env node\nimport "./tooling/cli.js";\n';
const dist = join(import.meta.dirname, "..", "dist");

await mkdir(dist, { recursive: true });

for (const name of ["okm.js", "okmodel.js"]) {
  const path = join(dist, name);
  await Bun.write(path, wrapper);
  await chmod(path, 0o755);
}
