import { raw } from "okmodel/pg";

declare const db: object;

export const rows = raw(db, "select id from tasks", []);
