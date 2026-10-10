# OKModel site

The documentation site. It is a private Next.js app, not part of the published `okmodel` package.

```sh
bun run site:dev
bun run site:check
bun run site:build
```

`site/lib/docs-map.ts` lists every public page. `bun run sync` (from this directory) writes `content/docs/` from the repository markdown. That directory is generated.

`mdast-util-to-markdown` is pinned to 2.1.2. 2.2 rewrites emphasis so the Fumadocs stringifier recurses forever on bold text.
