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
 * OKM1111 is reserved for a later prompt and is not listed.
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
    summary: "A preset uses a name reserved for a client method.",
    fix: "Rename the preset. okm upgrade renames a preset when a later release claims its name.",
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
    code: "OKM1130",
    title: "Cursor order",
    summary: "A cursor was reused with a different orderBy than the one that created it.",
    fix: "Request the next page with the same orderBy. The cursor encodes that order.",
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
    summary: "A migration is not expand-safe and has no reason.",
    fix: "Split the change into expand and contract, or pass a reason that CI can record.",
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
    fix: "Regenerate the snapshot from the history. okm migrate check is the command that reports this.",
  },
  {
    code: "OKM1522",
    title: "Apply lock held",
    summary: "Another apply already holds the target's migration lock.",
    fix: "Wait for that apply to finish. Do not start a second apply against the same target.",
  },
  {
    code: "OKM1530",
    title: "Ambiguous rename",
    summary: "A rename could match more than one object.",
    fix: "Declare the rename explicitly so the plan has one pairing.",
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
    summary: "A feature needs a newer Postgres or extension version than the one declared.",
    fix: "Raise the declared version, or avoid the feature. Core features are never gated on an extension.",
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
