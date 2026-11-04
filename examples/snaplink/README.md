# Snaplink

A link shortener on [OKModel](https://github.com/omqkhafi/okmodel), Hono, and
Cloudflare Workers, with Neon serverless as the database through `okmodel/pg/neon`.
Two tables (`links`, `clicks`), one client per request, and the click write runs
after the redirect through `waitUntil`. Delete is an interactive transaction in
`websocket` mode and an atomic batch in `http` mode.

| Route | What it does |
| --- | --- |
| `POST /links` | `{ "url": "https://...", "slug"?: "my-slug" }` creates a link. 409 if the slug is taken. |
| `GET /r/:slug` | 302 to the URL and records a click after the response. |
| `GET /links/:slug` | The link, its click count, and the last five clicks. |
| `DELETE /links/:slug` | Deletes the link and its clicks together. |
| `GET /health` | `{ ok, mode }`. |

## Setup

Use a Neon database you can drop, such as a branch. Install, then apply the
migration from your machine through the direct (non-pooler) Neon host:

```sh
bun install
export DATABASE_URL='postgres://user:pass@ep-example.region.aws.neon.tech/neondb?sslmode=require'
bunx okm migrate apply
```

Store the connection string as a Worker secret and deploy:

```sh
bunx wrangler secret put DATABASE_URL
bunx wrangler deploy
```

For local development, put `DATABASE_URL=...` in `.dev.vars` (not committed), run
`bunx wrangler dev`, and call it:

```sh
curl -i http://localhost:8787/health
curl -i -X POST http://localhost:8787/links -H 'content-type: application/json' \
  -d '{"url":"https://example.com","slug":"hello"}'
curl -i http://localhost:8787/r/hello
curl -i http://localhost:8787/links/hello
```

## NEON_MODE

`NEON_MODE` in `wrangler.jsonc` `vars` picks the Neon transport:

- `websocket` (default): a pooled connection per request. `db.tx()` works, so
  `DELETE /links/:slug` reads and writes on one connection.
- `http`: one fetch per statement. There is no interactive `db.tx()`, so
  `DELETE /links/:slug` reads first and then runs one `db.batch()`.

Any other value answers 500. Change it in `wrangler.jsonc`, or per deploy with
`wrangler deploy --var NEON_MODE:http`, and check `/health`.

`scripts/try-tx.ts` shows both behaviours against a real database:

```sh
DATABASE_URL=... bun scripts/try-tx.ts
```

## Types and tests

`worker-configuration.d.ts` is generated and not committed:

```sh
bun run types
bun run typecheck
```

From a clone of the OKModel repository, `bun run build` at the root and then
`bun test ./snaplink.test.ts` here bundles the Worker, runs strict `tsc`, applies
the migration, and calls the Worker in both modes through a local Neon endpoint
(needs `bun run db:up`).
