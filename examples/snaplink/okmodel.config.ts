import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./src/schema.ts",
  database: process.env.DATABASE_URL!,
});
