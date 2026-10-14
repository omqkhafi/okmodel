# OKModel site

The documentation site. It is a private Next.js app, not part of the published `okmodel` package.

```sh
bun dev
bun run site:check
bun run site:build
```

`site/lib/docs-map.ts` lists every public page. `bun run sync` (from this directory) writes `content/docs/` from the repository markdown. That directory is generated.

`mdast-util-to-markdown` is pinned to 2.1.2. 2.2 rewrites emphasis so the Fumadocs stringifier recurses forever on bold text.

## Status

The site is not deployed. The domain is not decided.

What works: the Start handbook (Let's start, Basic Usage), the Define handbook (Config, Schema, and Table), llms files, markdown negotiation, search, and the home page.

Known incomplete, and the backlog for the next site steps: docs layout polish against the okengine handbook (sidebar structure, introduction page, "On this page", duplicate Quickstart, long-page navigation, code block chrome).

First-load JavaScript gzip is over the audit goals: home 236202 bytes (goal 150000), docs page 311629 bytes (goal 250000).
