/**
 * PostgreSQL reserved keywords.
 *
 * An unquoted reserved word is rejected (OKM1122). Non-reserved keywords are
 * allowed as names. The list is the PostgreSQL 17 "reserved" column. The set
 * is built on first use.
 */

let words: ReadonlySet<string> | undefined;

/**
 * Reserved keywords, lowercase.
 *
 * @returns The PostgreSQL reserved-word set
 */
export function reservedWords(): ReadonlySet<string> {
  words ??= new Set(
    "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with".split(
      " ",
    ),
  );
  return words;
}
