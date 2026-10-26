import { POSTGRES_FLOOR, uuidv7NeedsPostgres } from "../../dialects/pg/floor.js";
import { RAW_STALE } from "../../dialects/pg/raw-lock.js";
import {
  VALIDATION_NOT_IMPORTED,
  VALIDATION_NOT_IMPORTED_FIX,
} from "../../runtime/validate/closed.js";
import { WARNING_RULES, type WarningRule } from "../../runtime/warnings/catalog.js";
import type { CliEscapeHatch, CliSafeAlternative } from "./shape.js";

/**
 * Doctor text for every OKM code in spec §21.
 *
 * This module is not on the runtime entry. A process that never explains a
 * code does not load it. Titles stay short. The summary and the fix are the
 * page `okm doctor <code>` will print.
 */

/** One code in the error registry. */
export type ErrorDoc = {
  /** Spec code, for example `OKM1020`. */
  readonly code: string;
  /** Short name. */
  readonly title: string;
  /** What went wrong. Never names a bypass. */
  readonly summary: string;
  /** The primary remedy. Never names a bypass. */
  readonly fix: string;
  /** Remedies that do not bypass the check. */
  readonly safeAlternatives?: readonly CliSafeAlternative[];
  /** Bypasses. Each one requires a human-written reason. */
  readonly escapeHatches?: readonly CliEscapeHatch[];
  /** Kebab-case id. Set on OKM2xxx and OKM3xxx advice. */
  readonly rule?: string;
  /** Development default before a project overrides it. */
  readonly defaultLevel?: WarningRule["defaultLevel"];
  /** Seriousness. The level is separate and can be changed. */
  readonly severity?: WarningRule["severity"];
  /** When the rule runs. */
  readonly phase?: WarningRule["phase"];
  /** Static query shape, or a later observation. */
  readonly evidence?: WarningRule["evidence"];
  /** Front-matter `since`. Absent means `0.9`. */
  readonly since?: string;
};

/**
 * One safe alternative on a code's page.
 *
 * @param code - Spec code
 * @param text - What to do instead
 * @returns The alternative, pointing at `#page`
 */
function alt(code: string, text: string): CliSafeAlternative {
  return { text, docs: `docs/errors/${code}.md#page` };
}

/**
 * One escape hatch. `requiresHumanReason` is always true.
 *
 * @param code - Spec code
 * @param name - Hatch the page names, kept out of `fix`
 * @returns The hatch, pointing at `#escape`
 */
function hatch(code: string, name: string): CliEscapeHatch {
  return { name, requiresHumanReason: true, docs: `docs/errors/${code}.md#escape` };
}

/**
 * Every OKM code spec §21 names, in numeric order.
 *
 * OKM1111 is a dynamic call the driver's capabilities do not allow.
 */
export const ERROR_DOCS: readonly ErrorDoc[] = [
  {
    code: "OKM1012",
    title: "Trait field conflict",
    summary: "A trait added a field that the table already declares.",
    fix: "Rename the table field or drop the trait that introduces it. The error names both.",
  },
  {
    code: "OKM1020",
    title: "Unknown table",
    summary: "A table, dependency, or catalog object is missing or does not match its identity.",
    fix: "Use a name that is in the schema. The error lists the accepted names and a nearest-name hint when one is close.",
  },
  {
    code: "OKM1021",
    title: "Foreign key target",
    summary: "A foreign key is missing its target table or column, or the target is ambiguous.",
    fix: "Name the referenced table and columns. The error lists the columns that exist on the target.",
  },
  {
    code: "OKM1022",
    title: "Foreign key type",
    summary: "A foreign key column and the column it references have different types.",
    fix: "Give both columns the same type. The error names the type that is accepted.",
  },
  {
    code: "OKM1023",
    title: "Duplicate name",
    summary:
      "Two catalog objects share an identity, two tables emit the same type name, or two fields of one table spell the same SQL name after casing.",
    fix: "Rename one of them, or name one with sqlName. Table names and emitted type names must be unique in the schema.",
  },
  {
    code: "OKM1024",
    title: "Table file not in schema",
    summary: "A table file is not passed to schema().",
    fix: "Add the file's table to the schema() call that okm check reads.",
  },
  {
    code: "OKM1025",
    title: "Multiple Register",
    summary: "More than one Register augmentation is in the project.",
    fix: 'Keep a single declare module "okmodel" that sets schema. Pass an explicit schema type everywhere else.',
  },
  {
    code: "OKM1026",
    title: "Dependency cycle",
    summary: "The catalog dependency graph contains a cycle, so objects cannot be ordered.",
    fix: "Break the cycle. The error is raised while ordering the catalog.",
  },
  {
    code: "OKM1027",
    title: "Unreadable catalog",
    summary: "The catalog document is malformed or uses a version this build cannot read.",
    fix: "Regenerate the catalog with this version of okmodel. Do not hand-edit the document.",
  },
  {
    code: "OKM1030",
    title: "Validation in two places",
    summary: "A field is validated both on the column and somewhere else.",
    fix: "Keep one validation for the field. The error names the field.",
  },
  {
    code: "OKM1040",
    title: "Preset name collision",
    summary:
      "A preset uses the name of a client method or a reserved name, or a table and its traits (or two traits) define the same preset.",
    fix: "Rename the preset. The error names both sources when two define it. okm upgrade renames a preset when a later release claims its name.",
  },
  {
    code: "OKM1051",
    title: "Archive foreign key",
    summary:
      "A foreign key into a table-strategy archivable table uses CASCADE, SET NULL, or SET DEFAULT and is not listed in cascade.",
    fix: "List the child table, the foreign key, and its action in cascade, or use RESTRICT or NO ACTION.",
  },
  {
    code: "OKM1052",
    title: "Not archivable",
    summary: "archive or restore was called on a table that is not archivable.",
    fix: "Call it only on an archivable table. The methods are absent from the types of other tables.",
  },
  {
    code: "OKM1060",
    title: "Invalid column",
    summary:
      "A column definition has a bad length, precision, scale, array rank, interval qualifier, or an empty or repeated picklist or enum. .unique() on a gin or gist index is this code too: Postgres builds unique indexes with btree only. A schema() casing other than snake or camel is this code too.",
    fix: "Use a value the error lists as accepted. Remove .unique() from a gin or gist index, or use btree. Pass snake or camel for casing, or leave it out.",
  },
  {
    code: "OKM1061",
    title: "Reserved option",
    summary: "The option exists in the types but this version does not implement it.",
    fix: "Remove the option until the prompt or milestone named in the error adds it.",
  },
  {
    code: "OKM1101",
    title: "Find without limit",
    summary:
      "find was called without a limit, or a limit is above limits.max. connect({ limits }) can set a default for find, page, and groupBy.",
    fix: "Pass a limit. A limit must not be above limits.max.",
    safeAlternatives: [
      alt("OKM1101", "Use page() with a cursor."),
      alt("OKM1101", "Set limits.find in connect for a default row count."),
    ],
    escapeHatches: [hatch("OKM1101", "all()")],
  },
  {
    code: "OKM1102",
    title: "Unfiltered write",
    summary: "A write with no effective predicate, including undefined values, is OKM1102.",
    fix: "Pass a predicate. An undefined-only where is the same as an empty filter.",
    escapeHatches: [hatch("OKM1102", "all()")],
  },
  {
    code: "OKM1104",
    title: "Upsert target",
    summary: "onConflict names columns that are not a unique constraint.",
    fix: "Set on to the columns of a unique constraint or the primary key.",
  },
  {
    code: "OKM1105",
    title: "Include without limit",
    summary:
      "A to-many include has no limit. connect({ limits: { include } }) sets a default for includes that name none.",
    fix: "Pass a limit on the include, or set limits.include in connect.",
    escapeHatches: [hatch("OKM1105", "all()")],
  },
  {
    code: "OKM1110",
    title: "Engine version",
    summary:
      "A feature needs a newer PostgreSQL than minPostgres allows. The message names the feature, the version it needs, and this schema's minimum.",
    fix: "Raise minPostgres, or stop using the feature. The error names both versions.",
  },
  {
    code: "OKM1111",
    title: "Missing capability",
    summary: "The call needs a driver capability this driver does not have.",
    fix: "Use a driver that declares the capability, or drop the call. The error names the flag.",
  },
  {
    code: "OKM1120",
    title: "Unknown field",
    summary:
      "The name is not a field or an option on a write, read, or update. An unknown key on insert, update, upsert, first-or-create, insert.validate, insert.check, or update.validate is refused and names the key and the table. timeout and signal go in the second argument of update. Options go first: tx(options, fn).",
    fix: "Use a field from the catalog, or move the option. The error includes a nearest-name hint when one is close.",
  },
  {
    code: "OKM1121",
    title: "Object as value",
    summary:
      "An empty or() branch is OKM1121. or() takes one array: or([a, b]). A plain object was passed where a value is required.",
    fix: "Give every or() branch a predicate. Pass an array: or([a, b]). Wrap a json value with eq.",
  },
  {
    code: "OKM1122",
    title: "Bad identifier",
    summary:
      "An identifier is empty, too long, contains NUL or another control character, or is an unquoted reserved word.",
    fix: "Use a shorter name without control characters. Quote is not accepted here. The error names the rule that failed.",
  },
  {
    code: "OKM1123",
    title: "Hidden field allowlist",
    summary: "A hidden field was added to a filter or sort allowlist.",
    fix: "Remove the hidden field from the allowlist. Hidden fields stay out of caller filters and sorts.",
  },
  {
    code: "OKM1124",
    title: "Operator mismatch",
    summary: "An operator does not apply to the column type.",
    fix: "Use an operator the error lists for that column type. Search needs a column built for search, not a plain text column.",
  },
  {
    code: "OKM1125",
    title: "Bad SQL fragment",
    summary:
      "A composed fragment is empty, unbalanced, includes a backslash, or interpolates a value it cannot bind. A select fragment that is not a number is the same code.",
    fix: "Interpolate a string, number, boolean, null, ident(name), fragment.column, or another fragment. Keep parentheses and quotes balanced. Pass a value that needs a backslash as an interpolation. A select fragment is a numeric expression named with as().",
  },
  {
    code: "OKM1126",
    title: "Parameter limit",
    summary:
      "The finished statement has more than 65,533 parameters. The limit is for the whole statement (filters, inList, limit, values), not for inList alone. It matches postgres.js (which refuses at 65,534) so OKM1126 fires before that driver's MAX_PARAMETERS_EXCEEDED.",
    fix: "Chunk the work, or filter with = any(array) instead of a long inList.",
  },
  {
    code: "OKM1127",
    title: "Relation order with distinct",
    summary: "orderBy on a relation is not available with distinct or distinctOn.",
    fix: "Order by a column of this table, or drop distinctOn.",
    since: "0.10",
  },
  {
    code: "OKM1128",
    title: "Relation order in aggregate",
    summary: "orderBy on a relation is not available in aggregate.",
    fix: "Order by a groupBy field, count, or a select name.",
    since: "0.10",
  },
  {
    code: "OKM1130",
    title: "Cursor order",
    summary:
      "A cursor was reused with a different orderBy than the one that created it, or is not a cursor page() returned.",
    fix: "Request the next page with the same orderBy and the exact next value the previous page returned. The cursor encodes that order.",
  },
  {
    code: "OKM1190",
    title: "Safety violation",
    summary:
      "A query composition broke a core invariant. violations lists every broken rule in stable order.",
    fix: "Change the contribution named on the first violation.",
    escapeHatches: [
      hatch("OKM1190", "unscoped()"),
      hatch("OKM1190", "all()"),
      hatch("OKM1190", "trusted()"),
      hatch("OKM1190", "allow"),
    ],
  },
  {
    code: "OKM1191",
    title: "No snapshot plan",
    summary:
      "A multi-statement read was requested inside READ COMMITTED and no single-statement plan exists.",
    fix: "Use REPEATABLE READ or SERIALIZABLE, or shape the read so it is one statement.",
  },
  {
    code: "OKM1200",
    title: "Validation failed",
    summary:
      "A write or a standalone check failed a validation rule. issues lists each path and message key.",
    fix: "Fix the fields named in issues. Each issue message is a key, not display text.",
  },
  {
    code: "OKM1201",
    title: "Validation not imported",
    summary: VALIDATION_NOT_IMPORTED,
    fix: VALIDATION_NOT_IMPORTED_FIX,
  },
  {
    code: "OKM1210",
    title: "Codec rejected a value",
    summary:
      "A codec refused a value: not numeric text, not a valid temporal value, or the wrong shape.",
    fix: "Pass a value the error lists as accepted. A missing Temporal global tells you to assign one to globalThis.Temporal.",
  },
  {
    code: "OKM1401",
    title: "Outcome unknown",
    summary:
      "A commit or batch was sent and its result never arrived, so the write may or may not have happened.",
    fix: "Check whether the write landed, using an idempotency key, before retrying. This error is never retried automatically.",
  },
  {
    code: "OKM1510",
    title: "Unsafe migration",
    summary:
      "A migration has an unresolved lint error, or an override with an empty reason or a code no statement in the step triggered.",
    fix: "Change the statement so the finding is gone. An override must name a code that a statement in the step triggered, and the reason must not be empty.",
    escapeHatches: [hatch("OKM1510", "-- okm-allow")],
  },
  {
    code: "OKM1511",
    title: "Drop table",
    summary: "A statement drops a table. The rows and anything that reads them are gone.",
    fix: "Stop reading the table in an expand migration, then drop it in a later contract.",
    escapeHatches: [hatch("OKM1511", "-- okm-allow")],
  },
  {
    code: "OKM1512",
    title: "Drop column",
    summary: "A statement drops a column. Stored values and the code that reads them are gone.",
    fix: "Stop reading the column in an expand migration, then drop it in a later contract.",
    escapeHatches: [hatch("OKM1512", "-- okm-allow")],
  },
  {
    code: "OKM1513",
    title: "Drop enum",
    summary: "A statement drops an enum that columns or code may still depend on.",
    fix: "Move every column off the enum first.",
    escapeHatches: [hatch("OKM1513", "-- okm-allow")],
  },
  {
    code: "OKM1514",
    title: "Drop domain",
    summary: "A statement drops a domain that columns or code may still depend on.",
    fix: "Move every column off the domain first.",
    escapeHatches: [hatch("OKM1514", "-- okm-allow")],
  },
  {
    code: "OKM1515",
    title: "Drop function",
    summary: "A statement drops a function that queries or triggers may still call.",
    fix: "Remove the callers in an expand migration, then drop the function.",
    escapeHatches: [hatch("OKM1515", "-- okm-allow")],
  },
  {
    code: "OKM1516",
    title: "Drop view",
    summary: "A statement drops a view that queries may still read.",
    fix: "Stop reading the view in an expand migration, then drop it.",
    escapeHatches: [hatch("OKM1516", "-- okm-allow")],
  },
  {
    code: "OKM1517",
    title: "Drop extension",
    summary:
      "A statement drops an extension. A dependent still in the catalog is refused before this finding.",
    fix: "Confirm nothing outside the catalog uses the extension.",
    escapeHatches: [hatch("OKM1517", "-- okm-allow")],
  },
  {
    code: "OKM1518",
    title: "Drop materialized view",
    summary: "A statement drops a materialized view and the rows it stores.",
    fix: "Stop reading the view in an expand migration, then drop it.",
    escapeHatches: [hatch("OKM1518", "-- okm-allow")],
  },
  {
    code: "OKM1519",
    title: "Rename column",
    summary: "A statement renames a column. Existing queries still use the old name.",
    fix: "Add the new column, backfill, and switch readers before dropping the old name.",
    escapeHatches: [hatch("OKM1519", "-- okm-allow")],
  },
  {
    code: "OKM1520",
    title: "Schema drift",
    summary: "The database has drifted past what an expand migration can repair.",
    fix: "Inspect the diff and repair the database, or generate a migration that matches the drift.",
  },
  {
    code: "OKM1521",
    title: "Snapshot mismatch",
    summary: "Provisioning from the snapshot does not match the replayed migration history.",
    fix: "Regenerate the snapshot from the history. okm migrate check --provision is the command that reports this.",
  },
  {
    code: "OKM1522",
    title: "Apply lock held",
    summary: "Another apply already holds the target's migration lock.",
    fix: "Wait for that apply to finish. Do not start a second apply against the same target.",
  },
  {
    code: "OKM1523",
    title: "Rename table",
    summary: "A statement renames a table. Existing queries still use the old name.",
    fix: "Create the new table, backfill, and switch readers before dropping the old name.",
    escapeHatches: [hatch("OKM1523", "-- okm-allow")],
  },
  {
    code: "OKM1524",
    title: "Column type change",
    summary:
      "A statement changes a column type. Existing readers and writers may not accept the new type.",
    fix: "Add a new column, backfill, and switch readers before dropping the old one.",
    escapeHatches: [hatch("OKM1524", "-- okm-allow")],
  },
  {
    code: "OKM1525",
    title: "Required column",
    summary: "A statement adds a NOT NULL column with no default to a table that already has rows.",
    fix: "Add the column nullable, backfill, then set it NOT NULL.",
    escapeHatches: [hatch("OKM1525", "-- okm-allow")],
  },
  {
    code: "OKM1526",
    title: "Drop default",
    summary: "A statement removes a column default. Writers that omitted the column will fail.",
    fix: "Update writers to send the column, then drop the default.",
    escapeHatches: [hatch("OKM1526", "-- okm-allow")],
  },
  {
    code: "OKM1527",
    title: "Shrink length",
    summary:
      "A statement shortens a character length. Values longer than the new limit no longer fit.",
    fix: "Shorten the stored values first, or keep the old length.",
    escapeHatches: [hatch("OKM1527", "-- okm-allow")],
  },
  {
    code: "OKM1528",
    title: "Unique constraint",
    summary:
      "A statement adds a unique or primary-key constraint on a table that already has rows.",
    fix: "Deduplicate the rows first.",
    escapeHatches: [hatch("OKM1528", "-- okm-allow")],
  },
  {
    code: "OKM1529",
    title: "Unique index",
    summary: "A statement creates a unique index on a table that already has rows.",
    fix: "Deduplicate the rows first.",
    escapeHatches: [hatch("OKM1529", "-- okm-allow")],
  },
  {
    code: "OKM1530",
    title: "Ambiguous rename",
    summary: "A rename could match more than one object.",
    fix: "Declare the rename explicitly so the plan has one pairing.",
  },
  {
    code: "OKM1531",
    title: "Validating check",
    summary: "A statement adds or validates a check against rows already stored.",
    fix: "Add the check NOT VALID, repair the rows, then validate it.",
    escapeHatches: [hatch("OKM1531", "-- okm-allow")],
  },
  {
    code: "OKM1532",
    title: "Validating foreign key",
    summary: "A statement adds or validates a foreign key against rows already stored.",
    fix: "Add the foreign key NOT VALID, repair the rows, then validate it.",
    escapeHatches: [hatch("OKM1532", "-- okm-allow")],
  },
  {
    code: "OKM1533",
    title: "Narrowing type",
    summary:
      "A statement narrows a numeric or integer type. Values outside the new range no longer fit.",
    fix: "Rewrite the values into the new range first.",
    escapeHatches: [hatch("OKM1533", "-- okm-allow")],
  },
  {
    code: "OKM1534",
    title: "Index locks",
    summary: "A statement creates an index on an existing table without CONCURRENTLY.",
    fix: "Create the index with CREATE INDEX CONCURRENTLY, outside a transaction. The planner does this on an existing table.",
  },
  {
    code: "OKM1535",
    title: "Check without NOT VALID",
    summary: "A statement adds a check on an existing table without NOT VALID.",
    fix: "Add the check NOT VALID, then validate it in its own step. The planner does this on an existing table.",
  },
  {
    code: "OKM1536",
    title: "Foreign key without NOT VALID",
    summary: "A statement adds a foreign key on an existing table without NOT VALID.",
    fix: "Add the foreign key NOT VALID, then validate it in its own step. The planner does this on an existing table.",
  },
  {
    code: "OKM1537",
    title: "Set not null",
    summary: "A statement sets NOT NULL on a column that already exists.",
    fix: "Add CHECK (column IS NOT NULL) NOT VALID, validate it, then SET NOT NULL and drop the check. The planner does this on an existing column.",
  },
  {
    code: "OKM1538",
    title: "Type rewrite",
    summary:
      "A statement changes a column type in a way that rewrites the table. Binary-coercible changes, varchar widening, varchar to text, and a numeric precision increase at the same scale do not.",
    fix: "There is no safe form for a rewriting type change in this version. A column swap is expand and contract work for a later step. OKM1524 already requires a reason for the type change.",
  },
  {
    code: "OKM1539",
    title: "Timestamp without time zone",
    summary:
      "A column is timestamp without time zone. The instant depends on the session time zone.",
    fix: "Use timestamptz.",
  },
  {
    code: "OKM1540",
    title: "varchar length",
    summary:
      "A column is varchar(n). text stores the same values without a length limit in the type.",
    fix: "Use text, and check the length in the application when one is required.",
  },
  {
    code: "OKM1541",
    title: "Picklist removal",
    summary: "A picklist or enum value was removed and the replacement was not given.",
    fix: "Pass --replace <table>.<column>.<old>=<new>, or =null on a nullable column. The replacement must be in the new list.",
  },
  {
    code: "OKM1542",
    title: "Data statement",
    summary:
      "A migration contains a data statement outside backfill(), or a DO or CALL whose body is not analysed.",
    fix: "Move insert, update, delete, merge, and truncate into backfill(). DO and CALL are refused because the body is not analysed.",
    escapeHatches: [hatch("OKM1542", "-- okm-allow")],
  },
  {
    code: "OKM1543",
    title: "serial column",
    summary: "A column uses serial or a nextval default. Identity is the form this repo generates.",
    fix: "Use an identity column generated always.",
  },
  {
    code: "OKM1544",
    title: "json column",
    summary: "A column is json. jsonb is available and stores the same documents in binary.",
    fix: "Use jsonb.",
  },
  {
    code: "OKM1545",
    title: "Identity not always",
    summary: "An identity column is generated by default. The repo default is generated always.",
    fix: "Declare the identity as generated always.",
  },
  {
    code: "OKM1546",
    title: "Backfill key",
    summary: "A backfill step targets a table that has no primary key.",
    fix: "Add a primary key. A backfill walks that key and does not scan the table.",
  },
  {
    code: "OKM1547",
    title: "History differs",
    summary:
      "Replaying a migration does not match its stored catalog, or the file was generated from a different parent than the previous migration.",
    fix: "Regenerate the migration from the previous catalog so the SQL and the stored catalog describe the same schema.",
  },
  {
    code: "OKM1548",
    title: "Previous catalog",
    summary:
      "An expand migration drops or changes a table, column, constraint, or type the previous catalog relies on.",
    fix: "Keep every table, column, constraint, and type the previous catalog relies on, or classify the migration as contract.",
  },
  {
    code: "OKM1549",
    title: "Stale head",
    summary: "The last migration's catalog does not match the schema.",
    fix: "okm generate writes the next migration.",
  },
  {
    code: "OKM1550",
    title: "Row-level security weakened",
    summary:
      "A statement disables row-level security, drops or widens a policy, grants BYPASSRLS, or changes the owner of a tenant table.",
    fix: "Remove the statement.",
    escapeHatches: [hatch("OKM1550", "-- okm-allow")],
  },
  {
    code: "OKM1551",
    title: "Transaction control in a step",
    summary:
      "A step contains COMMIT, ROLLBACK, or other transaction control, including inside a DO body. A function or procedure body is not this.",
    fix: "Remove the transaction control. okm migrate check replays one transaction and rolls it back.",
    escapeHatches: [hatch("OKM1551", "-- okm-allow")],
  },
  {
    code: "OKM1552",
    title: "Reprinted declaration",
    summary:
      "A domain check or a LANGUAGE sql function body is stored differently from the text in the migration catalog.",
    fix: "Write the check or the body the way Postgres prints it. The warning does not fail apply or migrate check. A reprinted domain check is sealed before the OKM1547 plan.",
    escapeHatches: [hatch("OKM1552", "-- okm-allow")],
  },
  {
    code: "OKM1553",
    title: "Step needs a human",
    summary:
      "A committed step failed and the probe cannot tell whether it is applied. Apply leaves it until someone decides.",
    fix: "Inspect the database. Record the step as applied when the change is in place, or mark it for another attempt. okm migrate resolve takes the step id from okm migrate status.",
  },
  {
    code: "OKM1554",
    title: "Step is not applied",
    summary: "Resolve refused to record the step because the probe says it is not applied.",
    fix: "Finish the change in the database, or mark the step for another attempt.",
  },
  {
    code: "OKM1555",
    title: "Unverified step",
    summary: "Resolve refused to record the step because this kind has no probe.",
    fix: "Confirm the change in the database, then record the step with explicit acceptance.",
  },
  {
    code: "OKM1556",
    title: "Step statement changed",
    summary: "The migration file's statement changed after the committed step started.",
    fix: "Restore the statement that started, or replace the file only after the database matches it.",
  },
  {
    code: "OKM1557",
    title: "Step cannot be made re-runnable",
    summary:
      "A committed step has no built-in probe and no declared probe, so a failure cannot tell whether the change is already in place.",
    fix: "Declare one read-only SELECT that returns a single boolean, true when the change is already in place, or keep the step inside the migration transaction.",
    escapeHatches: [hatch("OKM1557", "-- okm-allow")],
  },
  {
    code: "OKM1558",
    title: "Invalid probe",
    summary:
      "A probe is empty, is not one read-only SELECT, has more than one statement, or is declared on a step that stays inside a transaction.",
    fix: "Write one read-only SELECT that returns a single boolean, and put it on a step that cannot share a transaction.",
    escapeHatches: [hatch("OKM1558", "-- okm-allow")],
  },
  {
    code: "OKM1559",
    title: "Lowering refused",
    summary:
      "The dialect returned no statement for a change, a statement with no SQL, or a class that does not match the step kind.",
    fix: "The lowering for that change has to return at least one statement, and the class has to match the kind.",
  },
  {
    code: "OKM1601",
    title: "Stale typed SQL",
    summary: RAW_STALE.summary,
    fix: RAW_STALE.fix,
  },
  {
    code: "OKM1602",
    title: "Bad typed SQL",
    summary:
      "A raw statement is not one select or one write the checker can classify, two result columns share a name, or a typed raw call passed the wrong number of parameters.",
    fix: "Start the statement with select, insert, update, or delete. with is a write when it contains insert, update, delete, or merge. Give result columns distinct names. Pass one value per $n placeholder.",
  },
  {
    code: "OKM1603",
    title: "Raw SQL is not static",
    summary: "raw SQL must be a static string.",
    fix: "Pass a string literal or a template literal with no substitutions as the SQL.",
  },
  {
    code: "OKM1604",
    title: "Typed SQL is not locked",
    summary: "A raw statement in the source is not in the typed SQL lock.",
    fix: "okm raw sync writes the lock and the generated types. Commit both.",
  },
  {
    code: "OKM1605",
    title: "Stale typed SQL entry",
    summary: "A typed SQL lock entry is no longer called from the source.",
    fix: "okm raw sync writes the lock and the generated types. Commit both.",
  },
  {
    code: "OKM1701",
    title: "Tenant context missing",
    summary: "A tenant table was used on a client that has no tenant context.",
    fix: "Open the client with for() before reading or writing that table.",
    escapeHatches: [hatch("OKM1701", "unscoped()")],
  },
  {
    code: "OKM1702",
    title: "Unverifiable tenant SQL",
    summary:
      "Raw SQL on a tenant table cannot prove the tenant predicate. A raw write is this. A raw read that does not select the primary key with ident is this. A typed raw call, raw(db, sql, params), on a client of a schema with tenancy is this.",
    fix: 'Use update or delete, or select the primary key with ident(name). For a typed raw call, use the table API, or pass trusted(client, "reason") to send the SQL without a tenant predicate on purpose.',
    escapeHatches: [hatch("OKM1702", "unscoped()"), hatch("OKM1702", "trusted()")],
  },
  {
    code: "OKM1704",
    title: "Tenant key change",
    summary: "An update tried to change the tenant key.",
    fix: "Remove the tenant key from the update. Moving a row between tenants is not an update.",
  },
  {
    code: "OKM1705",
    title: "Global references tenant",
    summary: "A global table references a tenant table.",
    fix: "Drop the reference, or make the referencing table a tenant table.",
  },
  {
    code: "OKM1706",
    title: "Tenant index",
    summary:
      'An index on a tenant table does not lead with the tenant key, and the schema is not prefixing indexes. Prefixing is on unless indexes: false or tenantIndexes: false. index().global("reason") is the opt-out that does not raise this.',
    fix: 'Put the tenant key first, or leave indexes on so the schema adds it. index().global("reason") opts one index out. A using tail is not prefixed by putting the key first or by leaving indexes on. index().global("reason") is the option that works for it.',
  },
  {
    code: "OKM1707",
    title: "RLS role",
    summary:
      "A scoped call under rls ran as a role that owns the tenant tables, is a superuser, or has BYPASSRLS. The reason field says which. The message names the endpoint.",
    fix: "Connect as a role that is not the table owner, a superuser, or BYPASSRLS. okm seed under rlsTenancy runs as the application role. The owner gets this error.",
  },
  {
    code: "OKM1708",
    title: "RLS policy",
    summary:
      "A scoped call under rls found a tenant table whose row-level security is missing, not forced, or whose policies are not the ones okm generate emits. The message names the table and the endpoint.",
    fix: "Restore the policies okm generate emits for this rls schema.",
  },
  {
    code: "OKM1709",
    title: "Session setting",
    summary:
      "A sessionSettings() declaration or a db.with() value is not accepted: a name without a dot, a name that starts with a setting okm reserves for tenancy or is a built-in setting, a type that is not text, uuid, int, or bool, a value of the wrong type, an unknown key, or a required key that is missing. A client with a required setting refuses every statement until db.with() gives it. Nothing reached the database.",
    fix: "Declare names like app.user_id, pass each value as its declared type, and call db.with({ ... }) with every required key before the first query.",
  },
  {
    code: "OKM1801",
    title: "Dialect mismatch",
    summary: "The schema dialect and the driver dialect are not the same.",
    fix: "Open the schema with the driver package that matches it.",
  },
  {
    code: "OKM1802",
    title: "Server version",
    summary: "The connected server is older than this schema's minPostgres.",
    fix: "Upgrade the server, or lower minPostgres to a major the server meets.",
  },
  {
    code: "OKM1803",
    title: "Postgres floor",
    summary: `The connected server is older than PostgreSQL ${String(POSTGRES_FLOOR)}.`,
    fix: `Upgrade the server to PostgreSQL ${String(POSTGRES_FLOOR)} or higher.`,
  },
  {
    code: "OKM1810",
    title: "Extension not declared",
    summary: "An extension builder was used but the extension is not declared on the schema.",
    fix: "Declare the extension next to the schema that uses it.",
  },
  {
    code: "OKM1811",
    title: "Extension unavailable",
    summary: "A declared extension is not installed on the server.",
    fix: "Install the extension, or remove the declaration. okm doctor reports this against the connected server.",
  },
  {
    code: "OKM1812",
    title: "Feature version",
    summary:
      "A feature needs a newer PostgreSQL than minPostgres, or an extension version the server does not have. The message names the feature and the version.",
    fix: `Raise minPostgres, or avoid the feature. ${uuidv7NeedsPostgres()} An extension pin names the version to install. Core features are never gated on an extension.`,
  },
  {
    code: "OKM1813",
    title: "Extension defined twice",
    summary: "The same extension definition was registered twice.",
    fix: "Keep one definition. A second copy fails at build.",
  },
  {
    code: "OKM1814",
    title: "Extension change refused",
    summary:
      "The plan would downgrade an extension, move a non-relocatable one, or drop one that still has dependents. A NOSUPERUSER migration role that does not own the extension hits the same code when a step would alter that extension or one of its types.",
    fix: "Drop or move the dependents first. Postgres cannot lower an extension version. When the message says the role must be the owner, make the migration role the owner of the extension, or check as that owner.",
  },
  {
    code: "OKM1820",
    title: "View tenancy",
    summary: "A view over tenant tables does not expose the tenant key and is not marked global.",
    fix: "Expose the tenant key so the predicate can be applied, or declare global(reason).",
  },
  {
    code: "OKM1821",
    title: "Replace needs recreate",
    summary: "An incompatible replace would have to recreate dependents. CASCADE is never used.",
    fix: "Review the dependents the plan lists and recreate them explicitly.",
  },
  {
    code: "OKM1822",
    title: "Concurrent refresh",
    summary: "REFRESH CONCURRENTLY was declared without a unique index on the materialized view.",
    fix: "Add a unique index, or refresh without CONCURRENTLY.",
  },
  {
    code: "OKM1823",
    title: "Security definer path",
    summary: "A SECURITY DEFINER function has no search_path.",
    fix: "Set search_path on the function to the schemas it is allowed to see.",
  },
  {
    code: "OKM1824",
    title: "Function dependencies",
    summary:
      "A plpgsql function has no dependsOn. Postgres does not record dependencies inside the body.",
    fix: "List dependsOn. LANGUAGE sql with BEGIN ATOMIC is inferred and does not need the list.",
  },
  {
    code: "OKM1825",
    title: "Missing privilege",
    summary: "A role lacks a privilege on a managed object.",
    fix: "Grant the privilege, or change the role. okm doctor reports the object and the privilege.",
  },
  {
    code: "OKM1830",
    title: "Lock outside transaction",
    summary: "find was called with a row lock outside tx().",
    fix: "Take the lock inside tx(). Advisory locks are transaction-scoped too.",
  },
  {
    code: "OKM1840",
    title: "Replica not allowed",
    summary: "A replica route was used on an operation that requires the primary, or inside tx().",
    fix: "Use the primary. Writes, batch, locks, and tx() never go to a replica.",
  },
  {
    code: "OKM1841",
    title: "External object differs",
    summary: "An external object does not match the owner's exported catalog.",
    fix: "Update the dependency's export, or stop treating the object as external.",
  },
  {
    code: "OKM1842",
    title: "Cross-database foreign key",
    summary: "A foreign key points at a table in another database.",
    fix: "Keep the foreign key inside one database. Cross-catalog keys are allowed only there.",
  },
  {
    code: "OKM1843",
    title: "No eligible replica",
    summary:
      "A replica was required and none is eligible: unhealthy, behind the session, or none configured.",
    fix: "Configure a replica or drop the route. This call does not read the primary.",
  },
  {
    code: "OKM1844",
    title: "Fallback refused",
    summary: "An automatic read found no eligible replica and fallback is error.",
    fix: "Restore a replica, or set fallback to primary if the primary should absorb the read.",
  },
  {
    code: "OKM1845",
    title: "Target unresolved",
    summary: "The target could not be resolved. The tenant is unknown or the resolver failed.",
    fix: "Check the tenant id and the resolver. Connection details are not guessed.",
  },
  {
    code: "OKM1846",
    title: "Acquire timeout",
    summary: "The pool did not hand out a connection within timeouts.acquire.",
    fix: "Raise timeouts.acquire, or stop holding connections. The wait does not spill into another pool.",
  },
  {
    code: "OKM1850",
    title: "Protected target",
    summary: "The operation is blocked on a protected target.",
    fix: "Use a read-only command or an expand migration.",
    escapeHatches: [hatch("OKM1850", "--allow-protected")],
  },
  {
    code: "OKM1851",
    title: "Target not empty",
    summary: "Provisioning was asked to fill a target that already has objects.",
    fix: "Provision an empty schema or an empty database. A non-empty target is refused.",
  },
  {
    code: "OKM1852",
    title: "Protection mismatch",
    summary:
      "Targets that resolve to the same database disagree about protection, or tenants of one schema-per-tenant database do.",
    fix: "Give those targets the same protection flag. okm check and okm doctor both report this.",
  },
  {
    code: "OKM1853",
    title: "Target not named",
    summary: "Several targets are configured and the command was not given --target.",
    fix: "Pass --target <name>. The command does not guess.",
  },
  {
    code: "OKM1854",
    title: "Pooler session",
    summary:
      "Two statements on the same connection saw different backend pids. A transaction-mode pooler is in the way.",
    fix: "Use a direct connection.",
    escapeHatches: [hatch("OKM1854", "--allow-pooler")],
  },
  {
    code: "OKM1855",
    title: "Pull would overwrite",
    summary: "okm pull or okm import drizzle found a file it would replace. It writes nothing.",
    fix: "Pass --out <directory> to write somewhere else, or move the file.",
  },
  {
    code: "OKM1856",
    title: "Drizzle is not installed",
    summary: "okm import drizzle could not resolve drizzle-orm from the project.",
    fix: "Install drizzle-orm in the project that owns the schema.",
  },
  {
    code: "OKM1857",
    title: "Already has history",
    summary: "okm migrate baseline was asked to write history on a target that already has it.",
    fix: "Baseline is for a database with no OKModel history. Use okm migrate status, or point at another target.",
  },
  {
    code: "OKM1858",
    title: "Baseline mismatch",
    summary: "The live database does not match the model snapshot that baseline would record.",
    fix: "Change the schema or the database until they match, then okm migrate baseline records the match.",
  },
  {
    code: "OKM1859",
    title: "Store fingerprint",
    summary: "A store fingerprint blocks this state-changing command when there is no terminal.",
    fix: "Open a terminal for this invocation. A terminal is friction, not proof of a human.",
  },
  {
    code: "OKM1860",
    title: "Feature refused",
    summary: "The configured dialect refuses a feature this schema uses.",
    fix: "Use the portable alternative named in the error. The message names the dialect, the feature, and the first version that would support it when one exists.",
  },
  {
    code: "OKM1862",
    title: "Different driver",
    summary: "A driver package is already installed and the driver flag names a different one.",
    fix: "Drop the driver flag, or remove the installed driver package before choosing another.",
  },
  {
    code: "OKM1863",
    title: "Init decision",
    summary: "okm init needs a choice and this invocation is not interactive.",
    fix: "Pass the flag named in the message. The flags are --driver, --tenancy, and --install.",
  },
  {
    code: "OKM1864",
    title: "User-modified file",
    summary: "A file init recorded was edited, so init leaves it unchanged.",
    fix: "Keep the file, or pass the force-file flag with that path to replace it.",
  },
  {
    code: "OKM1865",
    title: "Unsupported project",
    summary: "The directory has no package.json, cannot be written, or a path leaves it.",
    fix: "Use a package directory that can be written, and keep paths inside it.",
  },
  {
    code: "OKM1866",
    title: "Plan hash mismatch",
    summary: "The plan hash does not match this directory anymore.",
    fix: "Print the plan again and pass the new plan-hash.",
  },
  {
    code: "OKM1867",
    title: "Tenancy mode",
    summary: "Tenancy schema or database is not supported by init yet.",
    fix: "Pass --tenancy none, or --tenancy column.",
  },
  {
    code: "OKM1881",
    title: "Agent files drifted",
    summary:
      "okm agents status found an agent file that is not current: the AGENTS.md block, the CLAUDE.md import, or a skill file is stale, missing, or modified.",
    fix: "Use okm agents update to rewrite the block and any unmodified skill, or okm init --agents when the files were never written.",
    since: "0.10",
  },
  {
    code: "OKM1882",
    title: "Agent markers damaged",
    summary:
      "A file has a BEGIN OKMODEL or END OKMODEL line that is malformed, unpaired, or out of order, so okm cannot tell which text it owns. It does not repair markers.",
    fix: "Restore one BEGIN OKMODEL line and one END OKMODEL line, or delete both and the text between them, then repeat the command.",
    since: "0.10",
  },
  {
    code: "OKM1883",
    title: "Agent block duplicated",
    summary:
      "A file has more than one OKMODEL block, so okm cannot tell which one it owns. It does not merge blocks.",
    fix: "Keep one OKMODEL block and delete the others, then repeat the command.",
    since: "0.10",
  },
  {
    code: "OKM1884",
    title: "Agent files need a yes",
    summary:
      "The plan changes an existing file, and okm cannot ask: there is no terminal, or --json is on, and --yes was not passed.",
    fix: "Read the plan with the dry flag, then pass --yes. Or answer the prompt on a terminal.",
    since: "0.10",
  },
  {
    code: "OKM1885",
    title: "Agent content refused",
    summary:
      "The skill files in the installed package are missing, are not markdown, are a symlink, or contain a hidden character. okm copies agent files only from its own package, and only when they pass these checks.",
    fix: "Reinstall okmodel from the registry.",
    since: "0.10",
  },
  {
    code: "OKM1886",
    title: "Agent path refused",
    summary:
      "An agent file path is not on the list okm may write, resolves outside the project directory, is not a regular file, or could not be written.",
    fix: "Keep the agent files as regular files inside the project directory.",
    since: "0.10",
  },
  {
    code: "OKM1887",
    title: "Agent file changed",
    summary:
      "A file changed after the plan was made and before it was replaced, so okm stopped. Files already written stay.",
    fix: "Repeat the command so the diff matches the file.",
    since: "0.10",
  },
  {
    code: "OKM1888",
    title: "Init record damaged",
    summary:
      ".okm/init.json is not a JSON object, so okm cannot record the hashes of the agent files it writes.",
    fix: "Restore .okm/init.json from version control, or delete it and use okm init again.",
    since: "0.10",
  },
  {
    code: "OKM1890",
    title: "Observer keys",
    summary: "writeObserver keys named a table that has no primary key or is not in the schema.",
    fix: "Add a primary key on that table, or remove it from writeObserver({ keys }).",
  },
  ...WARNING_RULES.map(warningDoc),
  {
    code: "OKM1891",
    title: "Ambiguous config",
    summary: "Two okmodel.config.ts files are the same distance from the working directory.",
    fix: "Pass --config <path> to the config this command should load.",
  },
  {
    code: "OKM1892",
    title: "Workspace choice",
    summary: "okm init needs a workspace and this invocation is not interactive.",
    fix: "Pass --workspace <name>, --all-workspaces, or --shared.",
  },
  {
    code: "OKM1893",
    title: "Shared migrations",
    summary: "Two packages use the same migrations directory.",
    fix: "Give each package its own migrations directory.",
  },
  {
    code: "OKM1894",
    title: "Testing object exists",
    summary: "testing() found a table or extension that already exists in the database.",
    fix: "Use an empty database, or pass migrate: false when the schema is already applied.",
    since: "0.10",
  },
  {
    code: "OKM1895",
    title: "Usage",
    summary: "The command line was not accepted.",
    fix: "`okm --help` lists the commands, and `okm <command> --help` lists that command's flags.",
    since: "0.10",
  },
  {
    code: "OKM1896",
    title: "Reprint needs a writable session",
    summary:
      "A check, picklist, domain check, generated column, or btree index expression is reprinted on a temporary table. This connection is read-only, or the role cannot create temporary tables.",
    fix: "Point the command at a writable primary. The role needs TEMP on the database. It does not need CREATE on the schema. Parallel runs use a random temporary name.",
    since: "0.10",
  },
  {
    code: "OKM2200",
    title: "Observer buffer overflow",
    summary:
      "The write-observer buffer dropped the oldest unit because it exceeded the pending-event ceiling.",
    fix: "Drain handlers with flush() more often, or raise maxPending on writeObserver. The write path does not wait.",
  },
  {
    code: "OKM2201",
    title: "Production timeouts",
    summary:
      "okm doctor --production found a lock_timeout or statement_timeout of 0. Apply or a statement can then wait without limit. The finding is a warning: nothing is refused.",
    fix: "Set timeouts.lock in the config, and ALTER ROLE <app role> SET statement_timeout to the limit you want.",
    since: "0.10",
  },
  {
    code: "OKM2202",
    title: "Target not protected",
    summary:
      "okm doctor --production selected a target that does not set protected: true in the config. A name such as production and NODE_ENV are never read. A fingerprint in this machine's store does not count: it protects one machine.",
    fix: "Set protected: true on the production target in okmodel.config.ts.",
    since: "0.10",
  },
  {
    code: "OKM2203",
    title: "Pooler target",
    summary:
      "okm doctor --production found a target URL that okm migrate apply refuses as a pooler: a host with pooler or pgbouncer in it, port 6543 or 6432, or ?pgbouncer=true. It is a warning, and a failure when the command line or the config lets apply through.",
    fix: "Point the target at a direct connection, and remove the setting that allows a pooler.",
    since: "0.10",
  },
  {
    code: "OKM2204",
    title: "Production check failed",
    summary:
      "okm doctor --production found at least one fail finding. The report lists each finding with its id and a one-line fix.",
    fix: "Fix each fail finding, then check the target again with okm doctor --production.",
    since: "0.10",
  },
  {
    code: "OKM2300",
    title: "Weak override reason",
    summary:
      "A migration override gives a reason that is shorter than 12 characters, only stop-list words, or only the code repeated. This is a warning: nothing is refused.",
    fix: "Write one sentence that says why this step is safe here: what was checked, and who agreed.",
    since: "0.10",
  },
  // Reserved, not registered (no raising path): version OKM1804–OKM1809,
  // extension OKM1815–OKM1819, feature refusal OKM1861 and OKM1868–OKM1879,
  // adapter capability refusal OKM1880 and OKM1889. OKM1881–OKM1888 (agent files) and
  // OKM1890–OKM1896 are registered.
  // OKM1140–OKM1179 stay reserved (D291).
];

/**
 * Copies one warning rule into a doctor entry.
 *
 * @param rule - Catalog rule
 * @returns The registry entry
 */
function warningDoc(rule: WarningRule): ErrorDoc {
  return {
    code: rule.code,
    title: rule.title,
    summary: rule.summary,
    fix: rule.fix,
    safeAlternatives: rule.safeAlternatives,
    escapeHatches: rule.escapeHatches,
    rule: rule.rule,
    defaultLevel: rule.defaultLevel,
    severity: rule.severity,
    phase: rule.phase,
    evidence: rule.evidence,
    since: "0.10",
  };
}

let byCode: ReadonlyMap<string, ErrorDoc> | undefined;

/**
 * Looks up one code.
 *
 * The map is built on the first call, not at import.
 *
 * @param code - Spec code, for example `OKM1401`
 * @returns The doctor entry, or `undefined` when the code is not in spec §21
 */
export function errorDoc(code: string): ErrorDoc | undefined {
  const index = byCode ?? indexDocs();
  return index.get(code);
}

function indexDocs(): ReadonlyMap<string, ErrorDoc> {
  const index = new Map<string, ErrorDoc>();
  for (const doc of ERROR_DOCS) index.set(doc.code, doc);
  byCode = index;
  return index;
}
