import { defineConfig } from "../../src/tooling/migrate/index.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error("DATABASE_URL is not set");
}

const preview = process.env.PREVIEW_DATABASE_URL ?? url;

export default defineConfig({
  schema: "./schema.ts",
  migrations: "./migrations",
  out: "./.okm",
  targets: {
    ci: { url },
    preview: { url: preview },
  },
});
