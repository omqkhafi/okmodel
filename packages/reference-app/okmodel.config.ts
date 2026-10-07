import { defineConfig, type TargetInput } from "okmodel/migrate";

const env = process.env;
const targets: Record<string, TargetInput> = {};
if (env.DATABASE_URL) targets.dev = env.DATABASE_URL;
if (env.PREVIEW_DATABASE_URL) targets.preview = env.PREVIEW_DATABASE_URL;
if (env.REHEARSAL_DATABASE_URL) targets.rehearsal = env.REHEARSAL_DATABASE_URL;
if (env.PRODUCTION_DATABASE_URL) {
  targets.production = { url: env.PRODUCTION_DATABASE_URL, protected: true };
}

export default defineConfig({
  schema: "./src/schema.ts",
  targets,
  backfill: { batchSize: 500 },
  roles: {
    migration: "okm",
    app: "ref_app",
    managed: [{ name: "ref_app", login: true }],
  },
});
