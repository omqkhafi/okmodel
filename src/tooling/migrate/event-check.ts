/**
 * Privilege and tag checks for event triggers.
 *
 * Creating one needs a superuser or a host-granted role. The probe runs in a
 * transaction and rolls it back. A plain role is 42501, reported as OKM2209.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { OkmError } from "../../contracts/error.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";

/** One live event trigger. */
export type LiveEventTrigger = {
  readonly name: string;
  readonly event: string;
  readonly tags: string;
  readonly enabled: string;
  readonly function: string;
};

/**
 * States whether this connection can create an event trigger, and probes tags.
 *
 * @param url - Target URL. Not printed
 * @param catalog - Catalog that may contain event triggers
 * @returns A line for `okm check`, or an empty string when none are declared
 */
export async function checkEventTriggers(url: string, catalog: Catalog): Promise<string> {
  const declared = catalog.objects.filter((object) => object.kind === "eventTrigger");
  if (declared.length === 0) return "";
  const pool = open({ url, max: 1 });
  try {
    const who = await pool.execute(
      "select current_user, (select rolsuper from pg_roles where rolname = current_user)",
    );
    const role = String(who.rows[0]?.[0] ?? "");
    const flag = who.rows[0]?.[1];
    const superuser = flag === "t" || flag === "true" || flag === "1";
    const name = `okm_evt_probe_${Math.floor(Math.random() * 1_000_000)}`;
    try {
      await pool.execute("begin");
      await pool.execute(
        `create function ${quoteIdent(name)}() returns event_trigger language plpgsql as $okm$begin end$okm$`,
      );
      await pool.execute(
        `create event trigger ${quoteIdent(name)} on ddl_command_end execute function ${quoteIdent(name)}()`,
      );
      for (const object of declared) {
        if (object.kind !== "eventTrigger" || object.definition.tags === undefined) continue;
        const tags = object.definition.tags.map((tag) => quoteLiteral(tag)).join(", ");
        await pool.execute(
          `create event trigger ${quoteIdent(`${name}_tags`)} on ${object.definition.event} when tag in (${tags}) execute function ${quoteIdent(name)}()`,
        );
        await pool.execute(`drop event trigger ${quoteIdent(`${name}_tags`)}`);
      }
      await pool.execute("rollback");
    } catch (error) {
      await pool.execute("rollback").catch(() => undefined);
      const state =
        Reflect.get(error as object, "sqlstate") ?? Reflect.get(error as object, "code");
      if (state === "42501") {
        throw new OkmError(
          "OKM2209",
          `Event triggers need a superuser or a host route. Required: superuser, Neon neon_superuser, or Supabase postgres. Found: ${role}, not a superuser (42501). Ask the provider which role can create an event trigger.`,
          { fix: { summary: "Connect as that role for okm check and okm apply." } },
        );
      }
      if (state === "42601" || state === "0A000") {
        throw new OkmError(
          "OKM1931",
          `An event trigger tag was refused (${String(state)}). ${error instanceof Error ? error.message : ""}`,
          { fix: { summary: "Remove the tag. Roles, databases, and tablespaces are out." } },
        );
      }
      throw error;
    }
    const found = superuser ? `${role}, superuser` : role;
    return `event triggers: required superuser or a host route (Neon neon_superuser, Supabase postgres). found: ${found}.\n`;
  } finally {
    await pool.close();
  }
}

/**
 * Reads every event trigger in the database.
 *
 * @param url - Target URL. Not printed
 * @returns Rows, or an empty list when the query fails closed
 */
export async function readEventTriggers(url: string): Promise<readonly LiveEventTrigger[]> {
  const pool = open({ url, max: 1 });
  try {
    const rows = await pool.execute(
      `select e.evtname, e.evtevent, e.evtenabled, coalesce(array_to_string(e.evttags, ', '), ''), p.proname
       from pg_event_trigger e
       join pg_proc p on p.oid = e.evtfoid
       order by e.evtname`,
    );
    return rows.rows.map((row) => ({
      name: String(row[0] ?? ""),
      event: String(row[1] ?? ""),
      enabled: String(row[2] ?? ""),
      tags: String(row[3] ?? ""),
      function: String(row[4] ?? ""),
    }));
  } finally {
    await pool.close();
  }
}

/**
 * Lines for doctor and access.
 *
 * A live trigger that the catalog does not declare is `unmanaged`, with the
 * tags it watches.
 *
 * @param live - Rows from {@link readEventTriggers}
 * @param declared - Names the catalog owns
 * @returns Text, or an empty string
 */
export function formatLiveEventTriggers(
  live: readonly LiveEventTrigger[],
  declared: ReadonlySet<string>,
): string {
  if (live.length === 0) return "";
  return `${live
    .map((row) => {
      const state = declared.has(row.name) ? "declared" : "unmanaged";
      const tags = row.tags.length > 0 ? row.tags : row.event;
      return `event trigger ${row.name} ${state} ${tags} calls ${row.function}`;
    })
    .join("\n")}\n`;
}
