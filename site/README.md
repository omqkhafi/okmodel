# OKModel site

The documentation site. It is a private Next.js app, not part of the published `okmodel` package. The public origin is `https://okm.omqkhafi.dev`.

```sh
bun dev
bun run site:check
bun run site:build
```

`content/docs/` is the handbook. Each page is an `.mdx` file with `title` and `description` frontmatter, and each folder's `meta.json` sets the sidebar order. Edit them in place. A new page also needs a line in its folder's `meta.json` and an icon in `lib/sidebar-icons.ts`.

`mdast-util-to-markdown` is pinned to 2.1.2. 2.2 rewrites emphasis so the Fumadocs stringifier recurses forever on bold text.

## Page template

A contract section is written with content specific to that page, or it is omitted.

- **When to use it** and **When not to** say something a reader could not infer from the title.
- **Options** is a table of that page's options.
- **What the plan shows** appears only where the feature has a plan step, and it names the real step and lock.
- **Errors** gives each code with one line of what triggers it.
- **Version** is the generated phrase (`<SupportPhrase />`).

`scripts/docs-sentences.ts` fails when the same sentence, after whitespace is collapsed, is 40 or more characters and appears on three or more handbook pages. The check does not name a sentence. `<SupportPhrase />` and `<Tagline />` are not page text, so the generated support sentence is exempt. A page's `since` is `"0.11"` when its file does not exist at tag `v0.10.6`. `scripts/docs-since.ts` follows renames and otherwise keeps the value already in the file.
