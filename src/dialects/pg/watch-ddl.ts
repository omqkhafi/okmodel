/**
 * Statement-level watch triggers.
 *
 * One function per watched table. PostgreSQL refuses transition tables on a
 * trigger that lists more than one event, so a tenant table gets three
 * triggers (insert, update, delete) and the function branches on `TG_OP`.
 * A table with no tenant column uses the same three triggers and a body that
 * only notifies. `push: false` emits nothing.
 *
 * The payload is `''` (wake every listener) or a JSON array of distinct tenant
 * keys. It is never row data. A payload longer than {@link WATCH_PAYLOAD_MAX}
 * bytes is sent as `''`.
 */

import { fitIdentifier } from "../../contracts/catalog/identifier.js";
import { functionObject, triggerObject } from "../../contracts/catalog/routine.js";
import type { CatalogObject } from "../../contracts/catalog/types.js";
import type { CatalogCompileInput } from "./catalog-draft.js";
import { quoteIdent } from "./ddl.js";
import { WATCH_PAYLOAD_MAX, watchChannel } from "./watch-channel.js";

const TRIGGER_INSERT = "okm_watch_insert";
const TRIGGER_UPDATE = "okm_watch_update";
const TRIGGER_DELETE = "okm_watch_delete";

/** A prepared table the compiler can see. */
type WatchTable = CatalogCompileInput["prepared"][number];

/**
 * Whether `name` is a watch trigger this compiler emits.
 *
 * @param name - Trigger name
 * @returns True for the three watch trigger names
 */
export function isWatchTriggerName(name: string): boolean {
  return name === TRIGGER_INSERT || name === TRIGGER_UPDATE || name === TRIGGER_DELETE;
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
  for (const item of input.prepared) {
    const declared = readWatch(item);
    if (declared === undefined || declared.push === false) continue;
    const channel = watchChannel(item.sqlName);
    const tenant = tenantColumns(item, input);
    const name = fitIdentifier(`okm_watch_${item.sqlName}`);
    const provenance = item.provenance;
    objects.push(
      functionObject({
        namespace: item.parent.namespace,
        name,
        returns: "trigger",
        language: "plpgsql",
        volatility: "volatile",
        security: "invoker",
        body: tenant === undefined ? plainBody(channel) : tenantBody(channel, tenant),
        provenance,
      }),
    );
    const call = {
      namespace: item.parent.namespace,
      name,
      argTypes: [] as readonly string[],
    };
    objects.push(
      triggerObject({
        parent: item.parent,
        name: TRIGGER_INSERT,
        timing: "after",
        events: ["insert"],
        level: "statement",
        calls: call,
        ...(tenant === undefined ? {} : { referencing: { new: "okm_new" } }),
        provenance,
      }),
      triggerObject({
        parent: item.parent,
        name: TRIGGER_UPDATE,
        timing: "after",
        events: ["update"],
        level: "statement",
        calls: call,
        ...(tenant === undefined ? {} : { referencing: { old: "okm_old", new: "okm_new" } }),
        provenance,
      }),
      triggerObject({
        parent: item.parent,
        name: TRIGGER_DELETE,
        timing: "after",
        events: ["delete"],
        level: "statement",
        calls: call,
        ...(tenant === undefined ? {} : { referencing: { old: "okm_old" } }),
        provenance,
      }),
    );
  }
  return objects;
}

function readWatch(item: WatchTable): { readonly push: boolean } | undefined {
  const watch = (item.options as { readonly watch?: unknown } | undefined)?.watch;
  if (watch === undefined) return undefined;
  if (watch === true) return { push: true };
  if (typeof watch === "object" && watch !== null && (watch as { push?: unknown }).push === false) {
    return { push: false };
  }
  return { push: true };
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
