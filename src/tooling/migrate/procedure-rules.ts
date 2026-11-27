/**
 * Procedure checks for `okm check` (OKM2125, OKM2126, OKM2127).
 *
 * The rules read the catalog. They do not connect. A routine that is not a
 * procedure still gets the body checks, because a function can raise and a
 * function body can hide a commit.
 */

import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import { routineControl } from "../../dialects/pg/fn/control.js";
import { warningRule, type WarningRule } from "../../runtime/warnings/catalog.js";

type Found = {
  readonly rule: WarningRule;
  readonly table: string;
  readonly target: string;
  readonly reason: string;
  readonly location?: { readonly file: string; readonly line: number };
};

const STANDARD_CLASS = new Set([
  "00",
  "01",
  "02",
  "03",
  "08",
  "09",
  "0A",
  "0B",
  "0F",
  "0L",
  "0P",
  "0Z",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "2B",
  "2D",
  "2F",
  "34",
  "38",
  "39",
  "3B",
  "3D",
  "3F",
  "40",
  "42",
  "44",
  "53",
  "54",
  "55",
  "57",
  "58",
  "72",
  "F0",
  "HV",
  "P0",
  "XX",
]);

/**
 * Findings for definer procedures, exception commits, and SQLSTATE names.
 *
 * @param catalog - The built catalog
 * @param tenancy - Schema tenancy key, when the schema set one
 * @returns Findings in catalog order
 */
export function procedureFindings(
  catalog: Catalog,
  tenancy: { readonly key: string } | undefined,
): readonly Found[] {
  const tenant = tenantTables(catalog, tenancy?.key);
  const found: Found[] = [];
  for (const object of catalog.objects) {
    if (object.kind !== "function") continue;
    const rule = warningRule("procedure-definer-tenant");
    if (
      rule !== undefined &&
      object.definition.routine === "procedure" &&
      object.definition.security === "definer"
    ) {
      const table = touchedTenant(object, tenant);
      if (table !== undefined) {
        found.push({
          rule,
          table,
          target: object.identity.name,
          reason: `Procedure ${object.identity.name} is security definer and touches tenant table ${table}. The owner bypasses row security.`,
        });
      }
    }
    const body = object.definition.body;
    if (routineControl(body).commitInException) {
      const handler = warningRule("procedure-commit-handler");
      if (handler !== undefined) {
        found.push({
          rule: handler,
          table: object.identity.name,
          target: object.identity.name,
          reason: `${object.identity.name} commits inside an EXCEPTION block.`,
        });
      }
    }
    found.push(...errcodeFindings(object));
  }
  return found;
}

function errcodeFindings(object: Extract<CatalogObject, { kind: "function" }>): Found[] {
  const rule = warningRule("procedure-errcode");
  if (rule === undefined) return [];
  const declared = new Set((object.definition.raises ?? []).map((item) => item.code.toUpperCase()));
  const found: Found[] = [];
  for (const item of object.definition.raises ?? []) {
    if (!standard(item.code)) continue;
    found.push({
      rule,
      table: object.identity.name,
      target: object.identity.name,
      reason: `${object.identity.name} declares ${item.name} as ${item.code}, which is a standard SQLSTATE class.`,
    });
  }
  for (const code of codesIn(object.definition.body)) {
    if (standard(code)) {
      found.push({
        rule,
        table: object.identity.name,
        target: object.identity.name,
        reason: `${object.identity.name} uses ${code}, which is a standard SQLSTATE class.`,
      });
      continue;
    }
    if (!declared.has(code)) {
      found.push({
        rule,
        table: object.identity.name,
        target: object.identity.name,
        reason: `${object.identity.name} raises ${code}, which raises does not name.`,
      });
    }
  }
  return found;
}

function codesIn(body: string): string[] {
  const found: string[] = [];
  const pattern = /\b(?:errcode|sqlstate)\s*(?:=)?\s*'([0-9A-Za-z]{5})'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const code = match[1]?.toUpperCase();
    if (code !== undefined && !found.includes(code)) found.push(code);
  }
  return found;
}

function standard(code: string): boolean {
  return STANDARD_CLASS.has(code.slice(0, 2).toUpperCase());
}

function tenantTables(catalog: Catalog, key: string | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  for (const object of catalog.objects) {
    if (object.kind === "table" && object.definition.rowSecurity?.enable === true) {
      names.add(object.identity.name);
    }
    if (object.kind === "column" && key !== undefined && object.identity.name === key) {
      names.add(object.identity.parent.name);
    }
  }
  return names;
}

function touchedTenant(
  object: Extract<CatalogObject, { kind: "function" }>,
  tenant: ReadonlySet<string>,
): string | undefined {
  for (const edge of object.dependencies) {
    const target = edge.target;
    if (target.kind === "table" && tenant.has(target.name)) return target.name;
    if (target.kind === "column" && tenant.has(target.parent.name)) return target.parent.name;
  }
  for (const table of tenant) {
    if (bodyNames(object.definition.body, table)) return table;
  }
  return undefined;
}

function bodyNames(body: string, table: string): boolean {
  const quoted = new RegExp(`"${table.replaceAll('"', '""')}"`, "i");
  if (quoted.test(body)) return true;
  return new RegExp(`\\b${table}\\b`, "i").test(body);
}
