/**
 * Reads a scratch schema back into normalized objects.
 *
 * Dependencies that Postgres records are a separate query. This module reads
 * the objects themselves.
 */

import { type ObjectKind } from "./object.js";
import { normalizeExpression, quoteLiteral } from "./sql.js";

/** A connection that can run one statement or one query. */
export type SqlRunner = {
  /** Runs one statement. */
  exec(statement: string): Promise<void>;
  /** Runs one query and returns its rows. */
  query(statement: string): Promise<readonly Record<string, unknown>[]>;
};

/**
 * One introspected object, still in the concrete schema.
 *
 * `namespace` is `undefined` for extensions.
 */
export type IntrospectedObject = {
  readonly kind: ObjectKind;
  readonly namespace: string | undefined;
  readonly parent: string | undefined;
  readonly name: string;
  readonly argTypes: readonly string[] | undefined;
  readonly attributes: Readonly<Record<string, string>>;
};

/**
 * Reads managed objects from concrete schemas, plus named extensions.
 *
 * @param runner - Scratch database
 * @param schemas - Schemas to read
 * @param extensions - Extension names to read. Other installed extensions are ignored
 * @returns Objects in concrete schema names
 */
export async function introspectObjects(
  runner: SqlRunner,
  schemas: readonly string[],
  extensions: readonly string[],
): Promise<readonly IntrospectedObject[]> {
  const objects: IntrospectedObject[] = [];
  if (schemas.length > 0) {
    const list = schemas.map((schema) => quoteLiteral(schema)).join(", ");
    objects.push(
      ...(await readTables(runner, list)),
      ...(await readColumns(runner, list)),
      ...(await readConstraints(runner, list)),
      ...(await readIndexes(runner, list)),
      ...(await readSequences(runner, list)),
      ...(await readDomains(runner, list)),
      ...(await readPartitions(runner, list)),
      ...(await readRelations(runner, list)),
      ...(await readFunctions(runner, list)),
      ...(await readTriggers(runner, list)),
      ...(await readPolicies(runner, list)),
    );
  }
  if (extensions.length > 0) {
    objects.push(...(await readExtensions(runner, extensions)));
  }
  return objects;
}

async function readTables(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, c.relname as name, c.relrowsecurity as row_security,
      case when c.relkind = 'p' then pg_get_partkeydef(c.oid) else null end as partkey
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in (${schemas})
      and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
  `);
  return rows.map((row) =>
    item("table", text(row, "schema"), undefined, text(row, "name"), undefined, {
      partition: partitionAttribute(text(row, "partkey")),
      rowSecurity: flag(row, "row_security"),
    }),
  );
}

async function readColumns(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, c.relname as parent, a.attname as name, t.typname as type,
      a.attnotnull as not_null, pg_get_expr(ad.adbin, ad.adrelid) as default_expr
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where n.nspname in (${schemas})
      and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
  `);
  return rows.map((row) =>
    item("column", text(row, "schema"), text(row, "parent"), text(row, "name"), undefined, {
      default: normalizeDefault(text(row, "default_expr")),
      nullable: flag(row, "not_null") === "true" ? "false" : "true",
      type: text(row, "type"),
    }),
  );
}

async function readConstraints(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, rel.relname as parent, con.conname as name, con.contype as contype,
      con.condeferrable as deferrable, con.condeferred as deferred,
      pg_get_constraintdef(con.oid) as definition,
      (
        select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
        from unnest(con.conkey) with ordinality as cols(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = cols.attnum
      ) as columns,
      ref.relname as ref_table,
      (
        select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
        from unnest(con.confkey) with ordinality as cols(attnum, ord)
        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = cols.attnum
      ) as ref_columns
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    left join pg_class ref on ref.oid = con.confrelid
    where n.nspname in (${schemas})
      and con.contype in ('p', 'u', 'f', 'c')
      and not exists (select 1 from pg_inherits i where i.inhrelid = rel.oid)
  `);
  return rows.map((row) => {
    const contype = text(row, "contype");
    const definition = text(row, "definition");
    const deferrable = flag(row, "deferrable") === "true";
    const deferred = flag(row, "deferred") === "true";
    const refTable = text(row, "ref_table");
    const refColumns = text(row, "ref_columns");
    return item(
      "constraint",
      text(row, "schema"),
      text(row, "parent"),
      text(row, "name"),
      undefined,
      {
        columns: text(row, "columns"),
        constraintKind: constraintKind(contype),
        deferrable: deferrable ? "true" : "false",
        expression: contype === "c" ? normalizeExpression(definition) : "",
        initially: !deferrable ? "" : deferred ? "deferred" : "immediate",
        nullsNotDistinct: /nulls not distinct/i.test(definition) ? "true" : "false",
        references: refTable === "" ? "" : `${refTable}(${refColumns})`,
      },
    );
  });
}

async function readIndexes(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, tbl.relname as parent, idx.relname as name, i.indisunique as is_unique,
      (
        select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
        from unnest(i.indkey) with ordinality as cols(attnum, ord)
        join pg_attribute a on a.attrelid = tbl.oid and a.attnum = cols.attnum
        where cols.attnum > 0
      ) as columns
    from pg_index i
    join pg_class idx on idx.oid = i.indexrelid
    join pg_class tbl on tbl.oid = i.indrelid
    join pg_namespace n on n.oid = tbl.relnamespace
    where n.nspname in (${schemas})
      and not i.indisprimary
      and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
  `);
  return rows.map((row) =>
    item("index", text(row, "schema"), text(row, "parent"), text(row, "name"), undefined, {
      columns: text(row, "columns"),
      unique: flag(row, "is_unique"),
    }),
  );
}

async function readSequences(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, c.relname as name, t.typname as type,
      s.seqstart::text as start, s.seqincrement::text as increment
    from pg_sequence s
    join pg_class c on c.oid = s.seqrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type t on t.oid = s.seqtypid
    where n.nspname in (${schemas})
  `);
  return rows.map((row) =>
    item("sequence", text(row, "schema"), undefined, text(row, "name"), undefined, {
      dataType: text(row, "type"),
      increment: text(row, "increment"),
      start: text(row, "start"),
    }),
  );
}

async function readDomains(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, t.typname as name, bt.typname as base_type, t.typnotnull as not_null
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_type bt on bt.oid = t.typbasetype
    where n.nspname in (${schemas}) and t.typtype = 'd'
  `);
  return rows.map((row) =>
    item("domain", text(row, "schema"), undefined, text(row, "name"), undefined, {
      baseType: text(row, "base_type"),
      notNull: flag(row, "not_null"),
    }),
  );
}

async function readPartitions(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, child.relname as name, parent.relname as parent,
      pg_get_expr(child.relpartbound, child.oid) as bound
    from pg_inherits inh
    join pg_class child on child.oid = inh.inhrelid
    join pg_class parent on parent.oid = inh.inhparent
    join pg_namespace n on n.oid = child.relnamespace
    where n.nspname in (${schemas})
      and child.relkind in ('r', 'p')
  `);
  return rows.map((row) => {
    const bound = text(row, "bound").trim().replace(/\s+/g, " ").replaceAll("'", "");
    const match = /^FOR VALUES FROM \((-?\d+)\) TO \((-?\d+)\)$/i.exec(bound.trim());
    const from = match?.[1] ?? "";
    const to = match?.[2] ?? "";
    return item(
      "partition",
      text(row, "schema"),
      text(row, "parent"),
      text(row, "name"),
      undefined,
      {
        bound: from === "" ? bound.trim() : `${from}:${to}`,
        parent: text(row, "parent"),
      },
    );
  });
}

async function readRelations(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, c.relname as name, c.relkind as relkind, c.relispopulated as populated,
      (
        select coalesce(string_agg(a.attname, ',' order by a.attnum), '')
        from pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ) as columns
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in (${schemas}) and c.relkind in ('v', 'm')
  `);
  return rows.map((row) => {
    const kind = text(row, "relkind") === "m" ? "materialized_view" : "view";
    const attributes: Record<string, string> = { columns: text(row, "columns") };
    if (kind === "materialized_view") attributes.withData = flag(row, "populated");
    return item(kind, text(row, "schema"), undefined, text(row, "name"), undefined, attributes);
  });
}

async function readFunctions(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, p.proname as name, rt.typname as returns, l.lanname as language,
      p.provolatile as volatility,
      (
        select coalesce(json_agg(t.typname order by args.ord), '[]'::json)
        from unnest(p.proargtypes) with ordinality as args(typ, ord)
        join pg_type t on t.oid = args.typ
      ) as arg_types
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type rt on rt.oid = p.prorettype
    join pg_language l on l.oid = p.prolang
    where n.nspname in (${schemas}) and p.prokind = 'f'
  `);
  return rows.map((row) => {
    const argTypes = stringList(row.arg_types);
    return item("function", text(row, "schema"), undefined, text(row, "name"), argTypes, {
      language: text(row, "language"),
      returns: text(row, "returns"),
      volatility: volatility(text(row, "volatility")),
    });
  });
}

async function readTriggers(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, c.relname as parent, t.tgname as name, t.tgtype as tgtype,
      p.proname as function,
      (
        select coalesce(json_agg(ty.typname order by args.ord), '[]'::json)
        from unnest(p.proargtypes) with ordinality as args(typ, ord)
        join pg_type ty on ty.oid = args.typ
      ) as arg_types
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname in (${schemas}) and not t.tgisinternal
  `);
  return rows.map((row) => {
    const parsed = triggerBits(Number(text(row, "tgtype")));
    return item("trigger", text(row, "schema"), text(row, "parent"), text(row, "name"), undefined, {
      events: parsed.events,
      function: text(row, "function"),
      functionArgTypes: stringList(row.arg_types).join(","),
      level: parsed.level,
      timing: parsed.timing,
    });
  });
}

async function readPolicies(
  runner: SqlRunner,
  schemas: string,
): Promise<readonly IntrospectedObject[]> {
  const rows = await runner.query(`
    select n.nspname as schema, c.relname as parent, pol.polname as name, pol.polcmd as command,
      pol.polpermissive as permissive,
      pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
      pg_get_expr(pol.polwithcheck, pol.polrelid) as check_expr
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in (${schemas})
  `);
  return rows.map((row) =>
    item("policy", text(row, "schema"), text(row, "parent"), text(row, "name"), undefined, {
      check: normalizeExpression(text(row, "check_expr")),
      command: policyCommand(text(row, "command")),
      permissive: flag(row, "permissive"),
      using: normalizeExpression(text(row, "using_expr")),
    }),
  );
}

async function readExtensions(
  runner: SqlRunner,
  extensions: readonly string[],
): Promise<readonly IntrospectedObject[]> {
  const list = extensions.map((name) => quoteLiteral(name)).join(", ");
  const rows = await runner.query(
    `select extname as name from pg_extension where extname in (${list})`,
  );
  return rows.map((row) =>
    item("extension", undefined, undefined, text(row, "name"), undefined, { installed: "true" }),
  );
}

function item(
  kind: ObjectKind,
  namespace: string | undefined,
  parent: string | undefined,
  name: string,
  argTypes: readonly string[] | undefined,
  attributes: Readonly<Record<string, string>>,
): IntrospectedObject {
  return { kind, namespace, parent, name, argTypes, attributes };
}

function partitionAttribute(partkey: string): string {
  if (partkey === "") return "";
  const match = /^(\w+)\s*\((.*)\)$/.exec(partkey.trim());
  if (match === null) return partkey.trim().toLowerCase();
  const method = match[1]?.toLowerCase() ?? "";
  const columns = (match[2] ?? "")
    .split(",")
    .map((column) => column.trim().replaceAll('"', ""))
    .join(",");
  return `${method}:${columns}`;
}

function constraintKind(contype: string): string {
  switch (contype) {
    case "p":
      return "primary_key";
    case "u":
      return "unique";
    case "f":
      return "foreign_key";
    case "c":
      return "check";
    default:
      return contype;
  }
}

function volatility(code: string): string {
  switch (code) {
    case "i":
      return "immutable";
    case "s":
      return "stable";
    case "v":
      return "volatile";
    default:
      return code;
  }
}

function policyCommand(command: string): string {
  switch (command) {
    case "r":
      return "select";
    case "a":
      return "insert";
    case "w":
      return "update";
    case "d":
      return "delete";
    case "*":
      return "all";
    default:
      return command;
  }
}

function triggerBits(tgtype: number): {
  readonly timing: string;
  readonly level: string;
  readonly events: string;
} {
  const instead = (tgtype & 64) !== 0;
  const before = (tgtype & 2) !== 0;
  const timing = instead ? "instead" : before ? "before" : "after";
  const level = (tgtype & 1) !== 0 ? "row" : "statement";
  const events: string[] = [];
  if ((tgtype & 4) !== 0) events.push("insert");
  if ((tgtype & 8) !== 0) events.push("delete");
  if ((tgtype & 16) !== 0) events.push("update");
  events.sort();
  return { timing, level, events: events.join(",") };
}

function normalizeDefault(expression: string): string {
  return expression
    .trim()
    .replace(/::[a-z0-9_ ]+$/i, "")
    .trim();
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  throw new Error(`${key} is not a scalar.`);
}

function flag(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === true || value === "t" || value === "true") return "true";
  if (value === false || value === "f" || value === "false") return "false";
  throw new Error(`${key} is not a boolean.`);
}

function stringList(value: unknown): readonly string[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Expected a list of type names.");
  return parsed.map((item) => {
    if (typeof item !== "string") throw new Error("Type name is not a string.");
    return item;
  });
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}
