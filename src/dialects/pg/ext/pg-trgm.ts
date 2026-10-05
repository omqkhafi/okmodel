/**
 * The `pg_trgm` extension.
 *
 * `similar` and `wordSimilar` are where-operators. Their SQL lives in the
 * lazy operator module. Index methods set the catalog `expression` to a
 * `using …` tail; the core index factory does not grow a `using` field.
 */

import { tag, type Tagged } from "../operators.js";
import type { IndexCall } from "../table.js";
import { extension, type Extension, type ExtensionOptions } from "./index.js";

/** Operand stored on a trigram operator. */
export type TrigramQuery = {
  readonly query: string;
  readonly schema: string;
};

/** `pg_trgm` plus its operators and index methods. */
export type PgTrgm = Extension & {
  /**
   * `column % query`.
   *
   * @param query - The text to compare
   * @returns A tagged where-operator
   */
  similar(query: string): Tagged<"similar", TrigramQuery>;
  /**
   * `column <% query`.
   *
   * @param query - The text to compare
   * @returns A tagged where-operator
   */
  wordSimilar(query: string): Tagged<"wordSimilar", TrigramQuery>;
  /**
   * A GIN index with `gin_trgm_ops`.
   *
   * @param column - SQL column name
   * @returns An index call whose expression is the `using` tail
   */
  gin(column: string): IndexCall;
  /**
   * A GiST index with `gist_trgm_ops`.
   *
   * @param column - SQL column name
   * @returns An index call whose expression is the `using` tail
   */
  gist(column: string): IndexCall;
};

/**
 * Declares `pg_trgm`.
 *
 * @param options - Schema and version pin
 * @returns The extension object and its operators
 */
export function pgTrgm(options: ExtensionOptions = {}): PgTrgm {
  const declared = extension("pg_trgm", options);
  const schema = declared.schema;
  return {
    ...declared,
    similar(query: string): Tagged<"similar", TrigramQuery> {
      return tag("similar", { query, schema });
    },
    wordSimilar(query: string): Tagged<"wordSimilar", TrigramQuery> {
      return tag("wordSimilar", { query, schema });
    },
    gin(column: string): IndexCall {
      return usingIndex(column, "gin", "gin_trgm_ops");
    },
    gist(column: string): IndexCall {
      return usingIndex(column, "gist", "gist_trgm_ops");
    },
  };
}

function usingIndex(column: string, method: string, opclass: string): IndexCall {
  const quoted = `"${column.replaceAll('"', '""')}"`;
  const call: IndexCall = {
    columns: [column],
    isUnique: false,
    expression: `using ${method} (${quoted} ${opclass})`,
    unique() {
      return call;
    },
  };
  return call;
}
