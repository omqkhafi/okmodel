import {
  VALIDATION_NOT_IMPORTED,
  VALIDATION_NOT_IMPORTED_FIX,
} from "../../runtime/validate/closed.js";

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
  /** What went wrong. */
  readonly summary: string;
  /** What to do. */
  readonly fix: string;
};

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
    summary: "Two catalog objects share an identity, or two tables emit the same type name.",
    fix: "Rename one of them. Table names and emitted type names must be unique in the schema.",
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
      "A column definition has a bad length, precision, scale, array rank, interval qualifier, or an empty or repeated picklist or enum.",
    fix: "Use a value the error lists as accepted.",
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
    summary: "find was called without a limit.",
    fix: "Pass limit, or call .all(reason) when the full set is intentional.",
  },
  {
    code: "OKM1102",
    title: "Unfiltered write",
    summary: "update or delete would run with an empty where.",
    fix: "Pass a filter. undefined in a write filter does not mean every row.",
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
    summary: "A to-many include has no limit.",
    fix: "Pass limit on the include, or call .all(reason).",
  },
  {
    code: "OKM1110",
    title: "Engine version",
    summary: "The feature needs a newer engine than schema({ requires }) allows.",
    fix: "Raise requires, or stop using the feature. The error names both versions.",
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
    summary: "A field name in where, select, orderBy, or include is not on the table.",
    fix: "Use a field from the catalog. The error includes a nearest-name hint when one is close.",
  },
  {
    code: "OKM1121",
    title: "Object as value",
    summary: "A plain object was passed where a value is required. JSON cannot create an operator.",
    fix: "Wrap the value with eq. eq is the equality form for json and jsonb.",
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
    fix: "Use an operator the error lists for that column type. Text search needs a tsvector column.",
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
    fix: "Change the contribution named on the first violation, or pass an explicit escape hatch (unscoped, all, trusted, allow) and record the reason.",
  },
  {
    code: "OKM1191",
    title: "No snapshot plan",
    summary:
      "A multi-statement read was requested inside READ COMMITTED and no single-statement plan exists.",
    fix: "Run the read in REPEATABLE READ or SERIALIZABLE, or shape it so it is one statement.",
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
      "A migration has an unresolved lint error, or an override with an empty reason or a code the statement did not trigger.",
    fix: "Put `-- okm-allow OKM15xx: reason` on the line above the statement. The code must be one that statement triggered, and the reason must not be empty.",
  },
  {
    code: "OKM1511",
    title: "Drop table",
    summary: "A statement drops a table. The rows and anything that reads them are gone.",
    fix: "Stop reading the table in an expand migration, then drop it in a later contract. Or allow OKM1511 with a reason.",
  },
  {
    code: "OKM1512",
    title: "Drop column",
    summary: "A statement drops a column. Stored values and the code that reads them are gone.",
    fix: "Stop reading the column in an expand migration, then drop it in a later contract. Or allow OKM1512 with a reason.",
  },
  {
    code: "OKM1513",
    title: "Drop enum",
    summary: "A statement drops an enum that columns or code may still depend on.",
    fix: "Move every column off the enum first. Or allow OKM1513 with a reason.",
  },
  {
    code: "OKM1514",
    title: "Drop domain",
    summary: "A statement drops a domain that columns or code may still depend on.",
    fix: "Move every column off the domain first. Or allow OKM1514 with a reason.",
  },
  {
    code: "OKM1515",
    title: "Drop function",
    summary: "A statement drops a function that queries or triggers may still call.",
    fix: "Remove the callers in an expand migration, then drop the function. Or allow OKM1515 with a reason.",
  },
  {
    code: "OKM1516",
    title: "Drop view",
    summary: "A statement drops a view that queries may still read.",
    fix: "Stop reading the view in an expand migration, then drop it. Or allow OKM1516 with a reason.",
  },
  {
    code: "OKM1517",
    title: "Drop extension",
    summary:
      "A statement drops an extension. A dependent still in the catalog is refused before this finding.",
    fix: "Confirm nothing outside the catalog uses the extension. Or allow OKM1517 with a reason.",
  },
  {
    code: "OKM1518",
    title: "Drop materialized view",
    summary: "A statement drops a materialized view and the rows it stores.",
    fix: "Stop reading the view in an expand migration, then drop it. Or allow OKM1518 with a reason.",
  },
  {
    code: "OKM1519",
    title: "Rename column",
    summary: "A statement renames a column. Existing queries still use the old name.",
    fix: "Add the new column, backfill, and switch readers before dropping the old name. Or allow OKM1519 with a reason.",
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
    fix: "Create the new table, backfill, and switch readers before dropping the old name. Or allow OKM1523 with a reason.",
  },
  {
    code: "OKM1524",
    title: "Column type change",
    summary:
      "A statement changes a column type. Existing readers and writers may not accept the new type.",
    fix: "Add a new column, backfill, and switch readers before dropping the old one. Or allow OKM1524 with a reason.",
  },
  {
    code: "OKM1525",
    title: "Required column",
    summary: "A statement adds a NOT NULL column with no default to a table that already has rows.",
    fix: "Add the column nullable, backfill, then set it NOT NULL. Or allow OKM1525 with a reason.",
  },
  {
    code: "OKM1526",
    title: "Drop default",
    summary: "A statement removes a column default. Writers that omitted the column will fail.",
    fix: "Update writers to send the column, then drop the default. Or allow OKM1526 with a reason.",
  },
  {
    code: "OKM1527",
    title: "Shrink length",
    summary:
      "A statement shortens a character length. Values longer than the new limit no longer fit.",
    fix: "Shorten the stored values first, or keep the old length. Or allow OKM1527 with a reason.",
  },
  {
    code: "OKM1528",
    title: "Unique constraint",
    summary:
      "A statement adds a unique or primary-key constraint on a table that already has rows.",
    fix: "Deduplicate the rows first. Or allow OKM1528 with a reason.",
  },
  {
    code: "OKM1529",
    title: "Unique index",
    summary: "A statement creates a unique index on a table that already has rows.",
    fix: "Deduplicate the rows first. Or allow OKM1529 with a reason.",
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
    fix: "Add the check NOT VALID, repair the rows, then validate it. Or allow OKM1531 with a reason.",
  },
  {
    code: "OKM1532",
    title: "Validating foreign key",
    summary: "A statement adds or validates a foreign key against rows already stored.",
    fix: "Add the foreign key NOT VALID, repair the rows, then validate it. Or allow OKM1532 with a reason.",
  },
  {
    code: "OKM1533",
    title: "Narrowing type",
    summary:
      "A statement narrows a numeric or integer type. Values outside the new range no longer fit.",
    fix: "Rewrite the values into the new range first. Or allow OKM1533 with a reason.",
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
    summary: "A statement changes a column type in a way that rewrites the table.",
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
    summary: "A migration contains a data statement outside backfill().",
    fix: "Move the statement into backfill(). Data changes are batched and resumable there.",
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
    fix: "Run okm generate.",
  },
  {
    code: "OKM1601",
    title: "Stale typed SQL",
    summary: "A typed SQL signature no longer matches the database.",
    fix: "Regenerate the typed SQL and commit the new signature.",
  },
  {
    code: "OKM1701",
    title: "Tenant context missing",
    summary: "A tenant table was used on a client that has no tenant context.",
    fix: "Open the client with the tenant context before reading or writing that table.",
  },
  {
    code: "OKM1702",
    title: "Unverifiable tenant SQL",
    summary: "Raw SQL touches a tenant table and the tenant predicate cannot be proved.",
    fix: "Use the query builder, or mark the fragment trusted with a reason if it is reviewed.",
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
    summary: "An index on a tenant table does not lead with the tenant key.",
    fix: "Put the tenant key first in the index columns.",
  },
  {
    code: "OKM1707",
    title: "RLS role",
    summary:
      "connect() was given a role that owns the tables or is a superuser, under the rls strategy.",
    fix: "Connect as a role that is neither the owner nor a superuser.",
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
    summary: "The connected server does not satisfy schema({ requires }).",
    fix: "Upgrade the server, or lower requires to a version the server meets.",
  },
  {
    code: "OKM1803",
    title: "Postgres floor",
    summary:
      "The connected server is older than PostgreSQL 15, and the schema does not set requires to that older major.",
    fix: "Upgrade the server to PostgreSQL 15 or newer, or set schema({ requires }) to the older major on purpose.",
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
      "A feature needs a newer Postgres or extension version than the one declared or connected.",
    fix: 'Raise the declared version, or avoid the feature. uuidv7() below 18 can use t.id({ default: "uuidv4" }), defaults.id set to "uuidv4", or a client generator. Core features are never gated on an extension.',
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
      "The plan would downgrade an extension, move a non-relocatable one, or drop one that still has dependents.",
    fix: "Drop or move the dependents first. Postgres cannot lower an extension version.",
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
    summary: "The application role lacks a privilege on a managed object.",
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
    summary: ".replica() was used on an operation that requires the primary, or inside tx().",
    fix: "Run the operation on the primary. Writes, batch, locks, and tx() never go to a replica.",
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
    fix: "Configure a replica or drop .replica(). This call does not read the primary.",
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
    summary: "The operation is blocked on a protected target and --allow-protected was not passed.",
    fix: "Run a read-only command or an expand migration, or pass --allow-protected for this invocation.",
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
];

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
