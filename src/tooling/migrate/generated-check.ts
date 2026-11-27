/**
 * Asks Postgres whether a generated expression is immutable, before apply.
 *
 * `okm check` and `okm plan` run every generated expression, including one
 * written with `sql` and one `okm pull` stored, through {@link checkScratch}.
 * The scratch column is STORED so PGlite can judge it. A non-immutable
 * expression is OKM1848 here, not at apply.
 */

import type { Catalog } from "../../contracts/catalog/types.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { sealGenerated } from "../../dialects/pg/generated-print.js";
import { checkScratch } from "./scratch-check.js";

/**
 * Refuses a generated expression the scratch database will not store.
 *
 * @param source - Catalog whose generated columns are checked
 * @param url - Provisioned database. Omitted uses the in-memory scratch database
 */
export async function assertGeneratedImmutable(source: Catalog, url?: string): Promise<void> {
  sealGenerated(source);
  let index = 0;
  for (const object of source.objects) {
    if (object.kind !== "column" || object.definition.generated === undefined) continue;
    const parent = object.identity.parent.name;
    const siblings = source.objects.flatMap((item) => {
      if (item.kind !== "column" || item.identity.parent.name !== parent) return [];
      if (item.identity.name === object.identity.name) return [];
      return [`${quoteIdent(item.identity.name)} ${item.definition.dataType}`];
    });
    siblings.push(
      `${quoteIdent(object.identity.name)} ${object.definition.dataType} generated always as (${object.definition.generated.expression}) stored`,
    );
    const verdict = await checkScratch(
      `create table ${quoteIdent(`okm_g_${String(index)}`)} (${siblings.join(", ")})`,
      url === undefined ? undefined : { url },
    );
    index += 1;
    if (!verdict.ok) throw verdict.error;
  }
}
