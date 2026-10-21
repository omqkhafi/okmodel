import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./db/schema.ts",
  migrations: "../web/migrations",
});
