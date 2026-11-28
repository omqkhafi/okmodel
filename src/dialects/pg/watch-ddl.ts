/**
 * Statement-level watch triggers.
 *
 * One function per watched table. PostgreSQL refuses transition tables on a
 * trigger that lists more than one event, and it refuses them on truncate, so
 * a watched table gets four triggers (insert, update, delete, truncate). A
 * tenant function branches on `TG_OP` and notifies `''` for truncate before it
 * reads a transition table. A table with no tenant column uses the same four
 * triggers and a body that only notifies. `push: false` emits nothing.
 * `watch.feed` keeps those four triggers, always with transition tables, and
 * inserts one row per key into `okm_changes`. The managed tables are emitted
 * once per schema.
 *
 * The payload is `''` (wake every listener) or a JSON array of distinct tenant
 * keys. It is never row data. A payload longer than {@link WATCH_PAYLOAD_MAX}
 * bytes is sent as `''`.
 */

import { fitIdentifier } from "../../contracts/catalog/identifier.js";
import { functionObject, triggerObject } from "../../contracts/catalog/routine.js";
import type { CatalogObject, Provenance } from "../../contracts/catalog/types.js";
import type { CatalogCompileInput } from "./catalog-draft.js";
import { quoteIdent } from "./ddl.js";
import { definition } from "./misuse.js";
import { WATCH_PAYLOAD_MAX, watchChannel } from "./watch-channel.js";
import {
  feedFunctionBody,
  feedKeepComment,
  managedFeedObjects,
  type FeedKey,
} from "./watch-feed-ddl.js";
import { parseKeep } from "./watch-keep.js";

const TRIGGER_INSERT = "okm_watch_insert";
const TRIGGER_UPDATE = "okm_watch_update";
const TRIGGER_DELETE = "okm_watch_delete";
const TRIGGER_TRUNCATE = "okm_watch_truncate";

/** A prepared table the compiler can see. */
type WatchTable = CatalogCompileInput["prepared"][number];

/**
 * Whether `name` is a watch trigger this compiler emits.
 *
 * @param name - Trigger name
 * @returns True for the four watch trigger names
 */
export function isWatchTriggerName(name: string): boolean {
  return (
    name === TRIGGER_INSERT ||
    name === TRIGGER_UPDATE ||
    name === TRIGGER_DELETE ||
    name === TRIGGER_TRUNCATE
  );
}

/**
 * Whether `name` is a watch function this compiler emits.
 *
 * @param name - Function name
 * @returns True when the name starts with `okm_watch_`
 */
export function isWatchFunctionName(name: string): boolean {
  return name.startsWith("okm_watch_");
}

/**
 * Function and trigger objects for every table that sets `watch`.
 *
 * @param input - Prepared tables and the schema's tenant fields
 * @returns Catalog objects, or an empty list
 */
export function watchObjects(input: CatalogCompileInput): CatalogObject[] {
  const objects: CatalogObject[] = [];
  let feedProvenance: Provenance | undefined;
  for (const item of input.prepared) {
    const declared = readWatch(item);
    if (declared === undefined || (declared.push === false && declared.keep === undefined))
      continue;
    const channel = watchChannel(item.sqlName);
    const tenant = tenantColumns(item, input);
    const name = fitIdentifier(`okm_watch_${item.sqlName}`);
    const provenance = item.provenance;
    const keep = declared.keep;
    const keys = keep === undefined ? [] : keyColumns(item);
    if (keep !== undefined && keys.length === 0) {
      definition(`Table ${item.tsName} watch.feed needs a primary key.`);
    }
    if (keep !== undefined) feedProvenance ??= provenance;
    const feed = keep !== undefined;
    objects.push(
      functionObject({
        namespace: item.parent.namespace,
        name,
        returns: "trigger",
        language: "plpgsql",
        volatility: "volatile",
        security: "invoker",
        body:
          keep === undefined
            ? tenant === undefined
              ? plainBody(channel)
              : tenantBody(channel, tenant)
            : feedFunctionBody({
                rel: item.sqlName,
                channel,
                keys,
                tenant,
                push: declared.push,
              }),
        ...(keep === undefined ? {} : { comment: feedKeepComment(keep.text) }),
        ...(feed
          ? {
              dependencies: [
                { kind: "table" as const, namespace: item.parent.namespace, name: "okm_changes" },
              ],
            }
          : {}),
        provenance,
      }),
    );
    const call = {
      namespace: item.parent.namespace,
      name,
      argTypes: [] as readonly string[],
    };
    const referencing = feed || tenant !== undefined;
    objects.push(
      triggerObject({
        parent: item.parent,
        name: TRIGGER_INSERT,
        timing: "after",
        events: ["insert"],
        level: "statement",
        calls: call,
        ...(referencing ? { referencing: { new: "okm_new" } } : {}),
        provenance,
      }),
      triggerObject({
        parent: item.parent,
        name: TRIGGER_UPDATE,
        timing: "after",
        events: ["update"],
        level: "statement",
        calls: call,
        ...(referencing ? { referencing: { old: "okm_old", new: "okm_new" } } : {}),
        provenance,
      }),
      triggerObject({
        parent: item.parent,
        name: TRIGGER_DELETE,
        timing: "after",
        events: ["delete"],
        level: "statement",
        calls: call,
        ...(referencing ? { referencing: { old: "okm_old" } } : {}),
        provenance,
      }),
      triggerObject({
        parent: item.parent,
        name: TRIGGER_TRUNCATE,
        timing: "after",
        events: ["truncate"],
        level: "statement",
        calls: call,
        provenance,
      }),
    );
  }
  if (feedProvenance !== undefined) {
    objects.push(...managedFeedObjects(input.namespace, feedProvenance));
  }
  return objects;
}

function readWatch(
  item: WatchTable,
):
  | { readonly push: boolean; readonly keep?: { readonly text: string; readonly ms: number } }
  | undefined {
  const watch = (item.options as { readonly watch?: unknown } | undefined)?.watch;
  if (watch === undefined) return undefined;
  if (watch === true) return { push: true };
  if (typeof watch !== "object" || watch === null) return { push: true };
  const record = watch as { readonly push?: unknown; readonly feed?: { readonly keep?: unknown } };
  const push = record.push !== false;
  const keep = record.feed === undefined ? undefined : parseKeep(record.feed.keep);
  if (!push && keep === undefined) return { push: false };
  return keep === undefined ? { push } : { push, keep };
}

function keyColumns(item: WatchTable): FeedKey[] {
  const columns = item.primaryKey?.columns ?? [];
  const fields = [...item.byField.entries()];
  return columns.map((sql) => {
    const field = fields.find(([, column]) => column.sqlName === sql)?.[0] ?? sql;
    return { field, sql };
  });
}

function tenantColumns(
  item: WatchTable,
  input: CatalogCompileInput,
): readonly string[] | undefined {
  const fields = input.tenancyFields;
  if (fields === undefined || fields.length === 0) return undefined;
  if (input.isPath?.(item.tsName) === true) return undefined;
  const tenancy = (
    item.options as { readonly tenancy?: { readonly kind?: string; readonly via?: string } }
  ).tenancy;
  if (tenancy?.kind === "global" || tenancy?.via !== undefined) return undefined;
  const sql = fields.flatMap((field) => {
    const column = item.byField.get(field);
    return column === undefined ? [] : [column.sqlName];
  });
  return sql.length > 0 ? sql : undefined;
}

function plainBody(channel: string): string {
  return `begin\n  perform pg_notify('${channel}', '');\n  return null;\nend`;
}

function tenantBody(channel: string, columns: readonly string[]): string {
  const expr = columns.map((name) => `${quoteIdent(name)}::text`).join(" || chr(31) || ");
  return [
    "declare tenants text;",
    "begin",
    "  if tg_op = 'TRUNCATE' then",
    `    perform pg_notify('${channel}', '');`,
    "    return null;",
    "  end if;",
    "  if tg_op = 'INSERT' then",
    `    select json_agg(distinct ${expr})::text into tenants from okm_new;`,
    "  elsif tg_op = 'DELETE' then",
    `    select json_agg(distinct ${expr})::text into tenants from okm_old;`,
    "  else",
    `    select json_agg(distinct token)::text into tenants from (select ${expr} as token from okm_new union select ${expr} from okm_old) s;`,
    "  end if;",
    "  if tenants is null then tenants := '[]'; end if;",
    `  if octet_length(tenants) > ${String(WATCH_PAYLOAD_MAX)} then`,
    `    perform pg_notify('${channel}', '');`,
    "  else",
    `    perform pg_notify('${channel}', tenants);`,
    "  end if;",
    "  return null;",
    "end",
  ].join("\n");
}
