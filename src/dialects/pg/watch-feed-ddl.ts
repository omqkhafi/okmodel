/**
 * Managed tables for the durable change feed.
 *
 * One schema that opts a table into `watch.feed` owns `okm_changes`,
 * `okm_cursors`, and `okm_feed_floor`. The column is `rel` because `table` is
 * reserved. `at` is what `keep` prunes by. `seq` is an identity so pull and
 * introspect share the owned-sequence path.
 */

import { identitySequenceName } from "../../contracts/catalog/identifier.js";
import { column, constraint, index, sequence, table } from "../../contracts/catalog/object.js";
import type { CatalogObject, Namespace, Provenance } from "../../contracts/catalog/types.js";
import { quoteIdent } from "./ddl.js";
import { WATCH_PAYLOAD_MAX } from "./watch-channel.js";

const CHANGES = "okm_changes";
const CURSORS = "okm_cursors";
const FLOOR = "okm_feed_floor";

const MANAGED = new Set([CHANGES, CURSORS, FLOOR]);

/** One primary-key column, as the app names it and as SQL names it. */
export type FeedKey = {
  readonly field: string;
  readonly sql: string;
};

/**
 * Whether `name` is a table the feed compiler owns.
 *
 * @param name - SQL table name
 * @returns True for `okm_changes`, `okm_cursors`, and `okm_feed_floor`
 */
export function isManagedFeedTable(name: string): boolean {
  return MANAGED.has(name);
}

/**
 * Reads `keep` back from the watch function comment.
 *
 * @param comment - Function comment, when the database has one
 * @returns The canonical duration, or `undefined`
 */
export function keepFromComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  const match = /^okm-feed (\S+)$/.exec(comment);
  return match?.[1];
}

/**
 * Comment stored on a feed function so pull can restore `keep`.
 *
 * @param text - Canonical duration from {@link parseKeep}
 * @returns The comment text
 */
export function feedKeepComment(text: string): string {
  return `okm-feed ${text}`;
}

/**
 * Tables, the identity sequence, the primary keys, and the read indexes.
 *
 * @param namespace - Schema namespace
 * @param provenance - Provenance of the table that opted in
 * @returns Catalog objects, in dependency order
 */
export function managedFeedObjects(namespace: Namespace, provenance: Provenance): CatalogObject[] {
  const changes = { namespace, name: CHANGES };
  const cursors = { namespace, name: CURSORS };
  const floor = { namespace, name: FLOOR };
  const seqName = identitySequenceName(CHANGES, "seq");
  const seq = sequence({
    namespace,
    name: seqName,
    dataType: "bigint",
    provenance,
    dependencies: [{ kind: "table", namespace, name: CHANGES }],
  });
  return [
    table({ namespace, name: CHANGES, provenance }),
    table({ namespace, name: CURSORS, provenance }),
    table({ namespace, name: FLOOR, provenance }),
    seq,
    column({
      parent: changes,
      name: "xid",
      dataType: "xid8",
      nullable: false,
      provenance,
    }),
    column({
      parent: changes,
      name: "seq",
      dataType: "bigint",
      nullable: false,
      identity: { always: true },
      provenance,
      dependencies: [seq.identity],
    }),
    column({
      parent: changes,
      name: "rel",
      dataType: "text",
      nullable: false,
      provenance,
    }),
    column({
      parent: changes,
      name: "op",
      dataType: "text",
      nullable: false,
      provenance,
    }),
    column({
      parent: changes,
      name: "key",
      dataType: "jsonb",
      nullable: false,
      provenance,
    }),
    column({
      parent: changes,
      name: "tenant",
      dataType: "text",
      nullable: true,
      provenance,
    }),
    column({
      parent: changes,
      name: "at",
      dataType: "timestamptz",
      nullable: false,
      defaultExpression: "clock_timestamp()",
      provenance,
    }),
    constraint({
      parent: changes,
      constraintKind: "primaryKey",
      columns: ["seq"],
      provenance,
    }),
    index({ parent: changes, columns: ["rel", "seq"], provenance }),
    index({ parent: changes, columns: ["rel", "at"], provenance }),
    column({ parent: cursors, name: "rel", dataType: "text", nullable: false, provenance }),
    column({ parent: cursors, name: "name", dataType: "text", nullable: false, provenance }),
    column({ parent: cursors, name: "seq", dataType: "bigint", nullable: false, provenance }),
    constraint({
      parent: cursors,
      constraintKind: "primaryKey",
      columns: ["rel", "name"],
      provenance,
    }),
    column({ parent: floor, name: "rel", dataType: "text", nullable: false, provenance }),
    column({ parent: floor, name: "seq", dataType: "bigint", nullable: false, provenance }),
    constraint({
      parent: floor,
      constraintKind: "primaryKey",
      columns: ["rel"],
      provenance,
    }),
  ];
}

/**
 * Function body that inserts change rows and, when `push` is set, notifies.
 *
 * Truncate has no transition table. It inserts one row and returns before any
 * read of `okm_new` or `okm_old`.
 *
 * @param input - Table, channel, keys, tenant columns, and whether to notify
 * @returns The plpgsql body, without dollar quotes
 */
export function feedFunctionBody(input: {
  readonly rel: string;
  readonly channel: string;
  readonly keys: readonly FeedKey[];
  readonly tenant: readonly string[] | undefined;
  readonly push: boolean;
}): string {
  const rel = quoteLiteral(input.rel);
  const channel = quoteLiteral(input.channel);
  const key = keyExpr(input.keys);
  const tenant = tenantExpr(input.tenant);
  const insert = (op: string, from: string): string =>
    [
      "    insert into okm_changes (xid, rel, op, key, tenant)",
      `    select pg_current_xact_id(), ${rel}, ${quoteLiteral(op)}, ${key}, ${tenant}`,
      `    from ${from};`,
    ].join("\n");
  const notify =
    input.push && input.tenant !== undefined
      ? tenantNotify(channel, input.tenant)
      : input.push
        ? [`  perform pg_notify(${channel}, '');`]
        : [];
  const declared = input.push && input.tenant !== undefined ? ["declare", "  tenants text;"] : [];
  const truncateNotify = input.push ? [`    perform pg_notify(${channel}, '');`] : [];
  return [
    ...declared,
    "begin",
    "  if tg_op = 'TRUNCATE' then",
    "    insert into okm_changes (xid, rel, op, key, tenant)",
    `    values (pg_current_xact_id(), ${rel}, 'truncate', '{}'::jsonb, null);`,
    ...truncateNotify,
    "    return null;",
    "  end if;",
    "  if tg_op = 'INSERT' then",
    insert("insert", "okm_new"),
    "  elsif tg_op = 'DELETE' then",
    insert("delete", "okm_old"),
    "  else",
    insert("update", "okm_new"),
    "  end if;",
    ...notify,
    "  return null;",
    "end",
  ].join("\n");
}

function tenantNotify(channel: string, columns: readonly string[]): string[] {
  const expr = tenantExpr(columns);
  return [
    "  if tg_op = 'INSERT' then",
    `    select json_agg(distinct ${expr})::text into tenants from okm_new;`,
    "  elsif tg_op = 'DELETE' then",
    `    select json_agg(distinct ${expr})::text into tenants from okm_old;`,
    "  else",
    `    select json_agg(distinct token)::text into tenants from (select ${expr} as token from okm_new union select ${expr} from okm_old) s;`,
    "  end if;",
    "  if tenants is null then tenants := '[]'; end if;",
    `  if octet_length(tenants) > ${String(WATCH_PAYLOAD_MAX)} then`,
    `    perform pg_notify(${channel}, '');`,
    "  else",
    `    perform pg_notify(${channel}, tenants);`,
    "  end if;",
  ];
}

function keyExpr(keys: readonly FeedKey[]): string {
  const parts = keys.flatMap((key) => [quoteLiteral(key.field), quoteIdent(key.sql)]);
  return `jsonb_build_object(${parts.join(", ")})`;
}

function tenantExpr(columns: readonly string[] | undefined): string {
  if (columns === undefined || columns.length === 0) return "null";
  return columns.map((name) => `${quoteIdent(name)}::text`).join(" || chr(31) || ");
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
