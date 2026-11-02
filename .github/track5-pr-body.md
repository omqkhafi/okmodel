## Summary

Unknown `/docs/*` paths returned HTTP 500 on the published site (`x-matched-path: /500`) because the catch-all called `notFound()` under on-demand generation and Next threw `NoFallbackError`. Old 0.10.0 handbook URLs under `/docs/define/*` and `/docs/start/*` were not redirected.

## Root cause

`site/app/docs/[[...slug]]/page.tsx` used `generateStaticParams` without `dynamicParams = false`. Requesting a path outside that set logged `Error: Internal: NoFallbackError` locally and served a cached 500 on Vercel. `/changelog/[series]` already set `dynamicParams = false` and correctly returned 404. Markdown `Accept` rewrote unknown docs paths to `/llms.mdx/docs/….md`, which hit the same failure on Vercel.

## Fix

- Set `dynamicParams = false` on the docs page and the docs markdown twin route so unknown paths 404 at the routing layer.
- Teach markdown negotiation to return a markdown 404 for missing handbook pages instead of rewriting to a twin that cannot be generated.
- Add permanent (308) redirects in `site/next.config.ts` via `site/lib/docs-redirects.ts`:
  - `/docs/define/table/validation` → `/docs/schema/validation`
  - `/docs/define/schema/tenancy` → `/docs/schema/tenancy`
  - `/docs/define/table/queries` → `/docs/queries/search-and-trees` (browser keeps `#text-search`; `#claim` is documented on `/docs/queries/write-rows#claim`)
  - `/docs/define/table/presets` → `/docs/queries/presets`
  - `/docs/define/table/traits` → `/docs/schema/traits`
  - `/docs/start/basic-usage` → `/docs/start/first-schema`
  - `/docs/start/from-drizzle` → `/docs/migrations/from-drizzle`
  - `/docs/define/:path*` → `/docs`

## Test plan

- [x] `bun run site:check`
- [x] `SITE_HTTP_BASE=… bun test ./lib/docs-redirects.site-test.ts` (404 / 308 / 200)
- [x] `format:check`, `lint`, `docs:check`, `readme:check`
- [x] Size gates unchanged (site-only)

Closes #639
