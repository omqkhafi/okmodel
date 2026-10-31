# Framework examples

Smallest apps that CI boots and calls. Each folder has its own `package.json`
so example dependencies stay out of the root package. The published tarball
does not include this directory.

| Example | Runtime | Driver | Verification |
| --- | --- | --- | --- |
| `nextjs` | Node | postgres.js | CI |
| `tanstack-start` | Node | postgres.js | CI |
| `hono` | Bun and Node | postgres.js | CI |
| `express` | Node or Bun | postgres.js | CI |
| `workers-neon` | Cloudflare Workers | Neon | Nightly (live) + CI (bundle) |

From the repository root, after `bun run build` and `bun run db:up`:

```sh
bun install --cwd examples/express
bun test examples/express/express.test.ts
```
