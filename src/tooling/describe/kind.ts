/**
 * Classifies one statement as `read` or `write` without parsing it.
 *
 * The first word outside comments, strings, and quoted identifiers decides.
 * `select` is a read. `insert`, `update`, and `delete` are writes. `with` is
 * a write when one of those, or `merge`, appears as a whole word, and a read
 * otherwise. A wrong write guess uses the primary, which is safe.
 */

import { OkmError } from "../../contracts/error.js";
import { sqlIdentifiers } from "../migrate/sql-lex.js";

/** Whether the statement reads or writes. */
export type RawKind = "read" | "write";

const WRITES: ReadonlySet<string> = new Set(["insert", "update", "delete", "merge"]);

/**
 * Classifies `sql`.
 *
 * @param sql - One statement, already normalised
 * @returns `read` or `write`
 * @throws OkmError OKM1602 when the first word is anything else
 */
export function rawKind(sql: string): RawKind {
  const names = sqlIdentifiers(sql);
  const first = names.find((name) => !name.quoted);
  const word = first?.text.toLowerCase();
  if (word === "select") return "read";
  if (word === "insert" || word === "update" || word === "delete") return "write";
  if (word === "with") {
    for (const name of names) {
      if (!name.quoted && WRITES.has(name.text.toLowerCase())) return "write";
    }
    return "read";
  }
  throw new OkmError(
    "OKM1602",
    "A raw statement must start with select, insert, update, delete, or with.",
    {
      fix: {
        summary:
          "Start the statement with select, insert, update, or delete. with is a write when it contains insert, update, delete, or merge.",
      },
    },
  );
}
