# Production

Nothing about an environment is inferred from `NODE_ENV` or from a target's name (spec §19.8).

- Set `protected: true` on the production target. A target named `production` is not protected by that name. `okm push` is refused only when the target is protected.
- Call `connect({ requireMeta: true })` for a production database. A missing `okm_meta` is then OKM1520. The default is off so an existing database can adopt OKModel.
- Pass `--target` whenever more than one target is configured. Omitting it is OKM1853.
- Do not point `okm migrate apply` at a pooler. A known pooler URL is refused unless `--allow-pooler` is set. Apply wants a direct connection.
- Leave `prepared` unset, or set `prepared: "unnamed"`, behind a transaction-mode pooler. `prepared: "named"` is for a direct connection. Named statements are not for a transaction-mode pooler.

```ts
import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./schema.ts",
  targets: {
    production: { url: process.env.DATABASE_URL, protected: true },
  },
});
```

```ts
const db = await connect(process.env.DATABASE_URL, {
  schema: app,
  requireMeta: true,
});
```

Apply that target by name:

```sh
okm migrate apply --target production
```
