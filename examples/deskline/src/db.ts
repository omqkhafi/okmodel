import { connect } from "okmodel/pg/postgresjs";
import { app } from "./schema.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

export const db = connect(url, { schema: app });
export type TenantDb = ReturnType<typeof db.for>;
