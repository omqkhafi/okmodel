/**
 * Compile handbook MDX before site tests import it.
 *
 * Bun otherwise treats `?collection=` imports as raw text, so `/api/search`
 * has no structured data to index. `bun run test` and `bun run check` preload
 * this file.
 */

import { createMdxPlugin } from "fumadocs-mdx/bun";

const mdx = createMdxPlugin();

await new Promise<void>((resolve, reject) => {
  Bun.plugin({
    name: mdx.name,
    setup(build) {
      void Promise.resolve(mdx.setup(build)).then(() => resolve(), reject);
    },
  });
});
