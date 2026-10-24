# OKModel site

The documentation site. It is a private Next.js app, not part of the published `okmodel` package. The public origin is `https://okm.omqkhafi.dev`.

```sh
bun dev
bun run site:check
bun run site:build
```

`content/docs/` is the handbook. Each page is an `.mdx` file with `title` and `description` frontmatter, and each folder's `meta.json` sets the sidebar order. Edit them in place. A new page also needs a line in its folder's `meta.json` and an icon in `lib/sidebar-icons.ts`.

`mdast-util-to-markdown` is pinned to 2.1.2. 2.2 rewrites emphasis so the Fumadocs stringifier recurses forever on bold text.
