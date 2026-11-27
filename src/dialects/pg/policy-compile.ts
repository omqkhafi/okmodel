/**
 * Compiles keyed row-level security policies into catalog objects.
 *
 * Installed into {@link readPolicyCompiler} when this module loads.
 * `schema()` does not import it, so a featureless app does not load it.
 */

import { OkmError } from "../../contracts/error.js";
import { fitIdentifier } from "../../contracts/catalog/identifier.js";
import { table as catalogTable } from "../../contracts/catalog/object.js";
import { isLegacyPolicy, policyObject } from "../../contracts/catalog/policy.js";
import type {
  CatalogObject,
  ObjectIdentity,
  PolicyCommand,
  RowSecurity,
} from "../../contracts/catalog/types.js";
import { quoteIdent } from "./ddl.js";
import { printIndexText } from "./index-print.js";
import { isOperator, operatorName, operatorValue } from "./operators.js";
import { installPolicyCompiler, type PolicyCompiler, type PolicyTableView } from "./policy-slot.js";

/** One command a policy covers. The default is `all`. */
export type PolicyFor = PolicyCommand;

/** `PERMISSIVE` or `RESTRICTIVE`. The default is permissive. */
export type PolicyAs = "permissive" | "restrictive";

/**
 * One keyed policy.
 *
 * The object key is the stored policy name. `to` defaults to the role key
 * `app`. `to: "public"` is `PUBLIC` and is a protected step.
 */
export type PolicySpec = {
  readonly as?: PolicyAs;
  readonly for?: PolicyFor;
  readonly to?: string | readonly string[];
  readonly using?: unknown;
  readonly check?: unknown;
  readonly comment?: string;
};

/** The object `policies()` returns. Keys are stored policy names. */
export type PolicyMap = Readonly<Record<string, PolicySpec>>;

/**
 * Table row security.
 *
 * `true` enables it. `false` disables it. `{ force: true }` enables and
 * forces it. `{ enable: false, force: true }` stores force and does not
 * enforce it.
 */
export type RlsOption = boolean | { readonly enable?: boolean; readonly force?: boolean };

const COMMANDS: readonly PolicyFor[] = ["select", "insert", "update", "delete", "all"];

/**
 * Compiles every table's `policies` and `rls` into `objects`.
 *
 * Generated tenancy policies are already in `objects`. A user policy that
 * reuses their name is refused. A permissive policy on a tenant table is
 * refused, because it would OR with the tenant policy.
 *
 * @param tables - Tables passed to `schema()`
 * @param view - SQL names and columns for one TypeScript table name
 * @param objects - Catalog objects collected so far. Policies are appended
 */
export const compileUserPolicies: PolicyCompiler = (tables, view, objects) => {
  const reads: { readonly table: string; readonly sql: string }[] = [];
  for (const item of tables) {
    const options = item.options as
      | { readonly policies?: unknown; readonly rls?: unknown }
      | undefined;
    if (options?.policies === undefined && options?.rls === undefined) continue;
    const info = view(item.name);
    if (info === undefined) {
      refuse(`Table ${item.name} is not in the schema.`);
    }
    compileTable(item.name, options, info, objects, reads);
  }
  assertNoCycle(reads);
};

installPolicyCompiler(compileUserPolicies);

function compileTable(
  tsName: string,
  options: { readonly policies?: unknown; readonly rls?: unknown } | undefined,
  info: PolicyTableView,
  objects: CatalogObject[],
  reads: { readonly table: string; readonly sql: string }[],
): void {
  const specs = readSpecs(tsName, options?.policies);
  const generated = generatedPolicies(objects, info.sqlName);
  const tenantForced = generated.some(
    (policy) => policy.identity.name === `${info.sqlName}_tenant` && policy.definition.force,
  );
  const state = rlsState(tsName, options?.rls, specs !== undefined, tenantForced);
  if (specs === undefined || Object.keys(specs).length === 0) {
    if (state.enable || state.force) stampRowSecurity(objects, info, state);
    return;
  }
  const keys = Object.keys(specs);
  for (const key of keys) {
    const spec = specs[key];
    if (spec === undefined || spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      refuse(`Policy ${key} on ${tsName} must be an object.`);
    }
    const stored = fitIdentifier(key);
    if (generated.some((policy) => policy.identity.name === stored)) {
      refuse(
        `Policy ${key} on ${tsName} uses the name ${stored}, which row-level security tenancy already emits.`,
      );
    }
    const command = readCommand(tsName, key, spec.for);
    const restrictive = readAs(tsName, key, spec.as, tenantForced);
    const roles = readRoles(spec.to);
    const using = spec.using;
    const check = spec.check;
    if ((command === "select" || command === "delete") && check !== undefined) {
      refuse(
        `Policy ${key} on ${tsName} is ${command} and cannot set check. check applies to writes.`,
      );
    }
    if (command === "insert" && using !== undefined) {
      refuse(`Policy ${key} on ${tsName} is insert and cannot set using. Use check.`);
    }
    if (command === "insert" && check === undefined) {
      refuse(`Policy ${key} on ${tsName} is insert and needs check.`);
    }
    if (command !== "insert" && using === undefined) {
      refuse(`Policy ${key} on ${tsName} needs using.`);
    }
    const expression =
      command === "insert"
        ? printPredicate(tsName, key, check, info, objects)
        : printPredicate(tsName, key, using, info, objects);
    const checkText =
      command === "insert" || check === undefined
        ? undefined
        : printPredicate(tsName, key, check, info, objects);
    const comment = spec.comment;
    if (comment !== undefined && typeof comment !== "string") {
      refuse(`Policy ${key} on ${tsName} comment must be text.`);
    }
    const dependencies = policyEdges(expression, checkText, info, objects);
    objects.push(
      policyObject({
        parent: info.parent,
        name: key,
        command,
        expression,
        force: state.force || tenantForced,
        ...(restrictive ? { restrictive: true as const } : {}),
        ...(roles === undefined ? {} : { roles }),
        ...(checkText !== undefined && checkText !== expression ? { check: checkText } : {}),
        ...(command === "insert" ? { checkOnly: true as const } : {}),
        ...(state.enable ? {} : { disabled: true as const }),
        ...(comment !== undefined ? { comment } : {}),
        provenance: info.provenance,
        dependencies,
      }),
    );
    reads.push({ table: info.sqlName, sql: `${expression}\n${checkText ?? ""}` });
  }
}

function readSpecs(tsName: string, value: unknown): PolicyMap | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    refuse(`Table ${tsName} policies must be a function that returns the policy object.`);
  }
  const specs = (value as () => unknown)();
  if (specs === null || typeof specs !== "object" || Array.isArray(specs)) {
    refuse(`Table ${tsName} policies() must return an object keyed by policy name.`);
  }
  return specs as PolicyMap;
}

function readCommand(tsName: string, key: string, value: unknown): PolicyFor {
  if (value === undefined) return "all";
  if (typeof value === "string" && COMMANDS.includes(value as PolicyFor)) return value as PolicyFor;
  refuse(`Policy ${key} on ${tsName} for must be select, insert, update, delete, or all.`);
}

function readAs(tsName: string, key: string, value: unknown, tenantForced: boolean): boolean {
  const restrictive = value === "restrictive";
  if (value !== undefined && value !== "permissive" && value !== "restrictive") {
    refuse(`Policy ${key} on ${tsName} as must be permissive or restrictive.`);
  }
  if (tenantForced && !restrictive) {
    refuse(
      `Policy ${key} on ${tsName} must be restrictive. A permissive policy ORs with the tenant policy and widens isolation.`,
    );
  }
  return restrictive;
}

function readRoles(value: unknown): readonly string[] | undefined {
  if (value === undefined) return ["app"];
  const list = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    refuse("Policy to must be a role key, a role name, or a list of them.");
  }
  const names = list as readonly string[];
  if (names.every((name) => name.toLowerCase() === "public")) return undefined;
  if (names.some((name) => name.toLowerCase() === "public")) {
    refuse("Policy to cannot mix PUBLIC with another role.");
  }
  return names;
}

function rlsState(
  tsName: string,
  value: unknown,
  hasPolicies: boolean,
  tenantForced: boolean,
): RowSecurity {
  if (tenantForced && lowersForce(value)) {
    refuse(
      `Table ${tsName} uses row-level security tenancy, which stays enabled and forced. rls cannot lower it.`,
    );
  }
  if (tenantForced && (value === undefined || value === true)) return { enable: true, force: true };
  return parseRls(tsName, value, hasPolicies);
}

function lowersForce(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as { readonly enable?: unknown; readonly force?: unknown };
  return record.enable === false || record.force === false;
}

function parseRls(tsName: string, value: unknown, hasPolicies: boolean): RowSecurity {
  if (value === undefined) return { enable: hasPolicies, force: false };
  if (value === true) return { enable: true, force: false };
  if (value === false) return { enable: false, force: false };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as { readonly enable?: unknown; readonly force?: unknown };
    if (record.enable !== undefined && typeof record.enable !== "boolean") {
      refuse(`Table ${tsName} rls.enable must be true or false.`);
    }
    if (record.force !== undefined && typeof record.force !== "boolean") {
      refuse(`Table ${tsName} rls.force must be true or false.`);
    }
    const force = record.force === true;
    const enable = record.enable === undefined ? force || hasPolicies : record.enable;
    return { enable, force };
  }
  refuse(`Table ${tsName} rls must be true, false, or { enable, force }.`);
}

function generatedPolicies(
  objects: readonly CatalogObject[],
  table: string,
): readonly (CatalogObject & { readonly kind: "policy" })[] {
  return objects.filter(
    (object): object is CatalogObject & { readonly kind: "policy" } =>
      object.kind === "policy" &&
      object.identity.parent.name === table &&
      isLegacyPolicy(object.definition),
  );
}

function stampRowSecurity(
  objects: CatalogObject[],
  info: PolicyTableView,
  state: RowSecurity,
): void {
  const index = objects.findIndex(
    (object) => object.kind === "table" && object.identity.name === info.sqlName,
  );
  const current = objects[index];
  if (current === undefined || current.kind !== "table") return;
  objects[index] = catalogTable({
    namespace: current.identity.namespace,
    name: current.identity.name,
    owner: current.owner,
    provenance: current.provenance,
    dependencies: current.dependencies.map((edge) => edge.target),
    ...(current.comment !== undefined ? { comment: current.comment } : {}),
    ...(current.definition.partition !== undefined
      ? { partition: current.definition.partition }
      : {}),
    rowSecurity: state,
  });
}

function printPredicate(
  tsName: string,
  key: string,
  value: unknown,
  info: PolicyTableView,
  objects: readonly CatalogObject[],
): string {
  try {
    return printPolicyValue(value, info, objects);
  } catch (error) {
    if (error instanceof OkmError) throw error;
    refuse(
      `Policy ${key} on ${tsName} could not be printed. ${error instanceof Error ? error.message : ""}`,
    );
  }
}

function printPolicyValue(
  value: unknown,
  info: PolicyTableView,
  objects: readonly CatalogObject[],
): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !isOperator(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    if (!("text" in record) && !("k" in record)) {
      const parts: string[] = [];
      for (const field of Object.keys(record)) {
        const item = record[field];
        if (isOperator(item) && operatorName(item) === "has") {
          parts.push(printHas(field, operatorValue(item), info, objects));
          continue;
        }
        parts.push(printIndexText({ [field]: item }, (name) => columnSql(info, name)));
      }
      if (parts.length === 0) refuse("A policy predicate where object is empty.");
      return parts.length === 1 ? (parts[0] as string) : `(${parts.join(" and ")})`;
    }
  }
  return printIndexText(value, (name) => columnSql(info, name));
}

function printHas(
  tableKey: string,
  inner: unknown,
  info: PolicyTableView,
  objects: readonly CatalogObject[],
): string {
  const related = relatedTable(tableKey, objects);
  const sql = related?.sql ?? tableKey;
  const pred = printIndexText(
    inner,
    (field) => `${quoteIdent(sql)}.${quoteIdent(related?.column(field) ?? field)}`,
    (field) => `${quoteIdent(info.sqlName)}.${quoteIdent(columnSql(info, field))}`,
  );
  return `exists (select 1 from ${quoteIdent(sql)} where ${pred})`;
}

function relatedTable(
  key: string,
  objects: readonly CatalogObject[],
): { readonly sql: string; readonly column: (field: string) => string } | undefined {
  const table = objects.find(
    (object) =>
      object.kind === "table" && (object.identity.name === key || object.provenance.name === key),
  );
  if (table === undefined || table.kind !== "table") return undefined;
  const columns = objects.filter(
    (object) => object.kind === "column" && object.identity.parent.name === table.identity.name,
  );
  return {
    sql: table.identity.name,
    column: (field) => {
      const match = columns.find(
        (object) =>
          object.kind === "column" &&
          (object.identity.name === field || object.provenance.name === field),
      );
      return match !== undefined && match.kind === "column" ? match.identity.name : field;
    },
  };
}

function columnSql(info: PolicyTableView, field: string): string {
  return info.column(field)?.sql ?? field;
}

function policyEdges(
  expression: string,
  check: string | undefined,
  info: PolicyTableView,
  objects: readonly CatalogObject[],
): readonly ObjectIdentity[] {
  const sql = `${expression}\n${check ?? ""}`;
  const edges: ObjectIdentity[] = [
    { kind: "table", namespace: info.parent.namespace, name: info.parent.name },
  ];
  for (const object of objects) {
    if (object.kind === "column" && object.identity.parent.name === info.sqlName) {
      if (sql.includes(quoteIdent(object.identity.name))) edges.push(object.identity);
    } else if (object.kind === "table" && object.identity.name !== info.sqlName) {
      if (sql.includes(quoteIdent(object.identity.name))) edges.push(object.identity);
    } else if (object.kind === "function") {
      if (
        sql.includes(`${object.identity.name}(`) ||
        sql.includes(quoteIdent(object.identity.name))
      ) {
        edges.push(object.identity);
      }
    }
  }
  return edges;
}

function assertNoCycle(reads: readonly { readonly table: string; readonly sql: string }[]): void {
  const graph = new Map<string, readonly string[]>();
  const tables = [...new Set(reads.map((item) => item.table))];
  for (const table of tables) {
    const sql = reads
      .filter((item) => item.table === table)
      .map((item) => item.sql)
      .join("\n");
    const next = tables.filter(
      (other) => sql.includes(`from ${quoteIdent(other)}`) || sql.includes(`${quoteIdent(other)}.`),
    );
    graph.set(table, next);
  }
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (table: string): void => {
    if (stack.has(table)) {
      refuseCycle(`${table} reads itself through a policy. PostgreSQL raises 42P17 at runtime.`);
    }
    if (seen.has(table)) return;
    stack.add(table);
    for (const next of graph.get(table) ?? []) visit(next);
    stack.delete(table);
    seen.add(table);
  };
  for (const table of tables) visit(table);
}

function refuse(message: string): never {
  throw new OkmError("OKM1924", message, {
    fix: {
      summary: "Change the policy so it matches one command, one role list, and the tenancy rules.",
    },
  });
}

function refuseCycle(message: string): never {
  throw new OkmError("OKM1925", message, {
    fix: { summary: "Break the cycle. A policy cannot read a table whose policies read it back." },
  });
}
