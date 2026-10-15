---
name: okmodel
description: Read the OKModel handbook before answering how to define a schema, call the client, migrate, or read an error. Use when the user asks about okmodel, a handbook page, or which page to open. Start at /llms.txt, then fetch one page.
---

# OKModel

OKModel is a Postgres schema and query library. The public handbook is the source for how a caller uses it.

## Read the handbook

1. Fetch `/llms.txt`. It lists every page as markdown, in sidebar order.
2. Fetch one linked page. A page is `/llms.mdx/docs/<slug>.md`. The introduction is `/llms.mdx/docs/index.md`.
3. Fetch `/llms-full.txt` only when the question spans the whole handbook.
4. `/llms.json` is the same set as JSON. Each page has `slug`, `title`, `description`, `html`, and `markdown`.

Send `Accept: text/markdown` on an HTML handbook URL to receive that page. The response sets `Vary: Accept`.

The HTTP `Link` header on every response advertises `/llms.txt` (`rel="describedby"`), `/sitemap.xml` (`rel="sitemap"`), and `/.well-known/agent-skills/index.json` (`rel="agent-skills"`). A handbook URL also advertises its markdown twin with `rel="alternate"`.

## In the browser

When `document.modelContext` or `navigator.modelContext` exists, the page registers three read-only tools: `search_docs`, `get_page`, and `list_pages`. `search_docs` takes `query` and reads `/api/search`. `get_page` takes `slug` and reads that page as markdown. `list_pages` reads `/llms.json`.

## Changing the repository

Normative text is `docs/okmodel-api-design.md` and `docs/okmodel-decisions.md` in the repository. Contributor rules are `AGENTS.md`. Closing a user-visible change is the `okm-ship` skill, documented on the Skills page.
