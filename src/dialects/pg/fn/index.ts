/**
 * `okmodel/fn`.
 *
 * `fn()` and `trigger()` return objects that produce their own catalog
 * records. `schema()` only asks each declared object for those records.
 */

import { assertIdentifier } from "../../../contracts/catalog/identifier.js";
import { OkmError } from "../../../contracts/error.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import { functionObject, triggerObject } from "../../../contracts/catalog/routine.js";
import type {
  CatalogObject,
  FunctionLanguage,
  FunctionSecurity,
  FunctionVolatility,
  ObjectIdentity,
  ObjectRef,
  Provenance,
  TriggerEvent,
  TriggerLevel,
  TriggerTiming,
} from "../../../contracts/catalog/types.js";
import type { AnyTable, SqlText } from "../table.js";

/** One argument of {@link fn}. */
export type FunctionArgumentInput = {
  readonly name: string;
  readonly type: string;
};

/**
 * A table, or one column of a table.
 *
 * A table is an object dependency. `{ table, column }` is a column dependency.
 * `column` is the SQL name.
 */
export type DependsOn = AnyTable | { readonly table: AnyTable; readonly column: string };

/** Options for {@link fn}. */
export type FunctionOptions = {
  readonly arguments?: readonly FunctionArgumentInput[];
  readonly returns: string;
  readonly language: FunctionLanguage;
  readonly volatility?: FunctionVolatility;
  readonly security?: FunctionSecurity;
  /** Required when `security` is `"definer"` (OKM1823). */
  readonly searchPath?: string;
  readonly body: SqlText | string;
  /**
   * Tables and columns the body uses.
   *
   * Required for plpgsql (OKM1824). Omitted for `LANGUAGE sql` that begins
   * with `BEGIN ATOMIC`; those edges are read from `pg_depend`.
   */
  readonly dependsOn?: readonly DependsOn[];
  /** Schema. The default is `public`. */
  readonly schema?: string;
};

/**
 * One declared function.
 *
 * `contribute` builds the catalog record. Overloads differ by argument types.
 */
export type Routine = {
  readonly name: string;
  readonly schema: string;
  readonly argTypes: readonly string[];
  /**
   * Catalog record for this declaration.
   *
   * @param peers - The `schema({ functions })` list
   * @param built - Objects the schema has already staged
   * @returns The function record
   */
  contribute(peers: unknown, built: unknown): readonly CatalogObject[];
};

/** Options for {@link trigger}. */
export type TriggerOptions = {
  readonly on: AnyTable;
  readonly timing: TriggerTiming;
  readonly events: readonly TriggerEvent[];
  readonly level: TriggerLevel;
  /** `UPDATE OF` columns. SQL names. Each one is a column dependency. */
  readonly updateOf?: readonly string[];
  readonly when?: SqlText | string;
  readonly calls: Routine;
};

/**
 * One declared trigger.
 *
 * Identity is `(table, name)`.
 */
export type TriggerDeclaration = {
  readonly name: string;
  /**
   * Catalog record for this declaration.
   *
   * @param peers - The `schema({ triggers })` list
   * @param built - Objects the schema has already staged
   * @returns The trigger record
   */
  contribute(peers: unknown, built: unknown): readonly CatalogObject[];
};

/**
 * Declares a function.
 *
 * plpgsql without `dependsOn` is OKM1824. `security: "definer"` without
 * `searchPath` is OKM1823.
 *
 * @param name - Function name
 * @param options - Signature, language, body, and dependencies
 * @returns The definition object `schema({ functions })` stores
 */
export function fn(name: string, options: FunctionOptions): Routine {
  const language = options.language;
  const body = bodyText(options.body);
  const atomic = language === "sql" && /^\s*begin\s+atomic\b/i.test(body);
  if (language === "plpgsql" && options.dependsOn === undefined) {
    throw new OkmError(
      "OKM1824",
      `Function ${name} is plpgsql and has no dependsOn. Postgres does not record dependencies inside the body.`,
      {
        fix: {
          summary:
            "List dependsOn. LANGUAGE sql with BEGIN ATOMIC is inferred and does not need the list.",
        },
      },
    );
  }
  if (
    options.security === "definer" &&
    (options.searchPath === undefined || options.searchPath.trim().length === 0)
  ) {
    throw new OkmError("OKM1823", `Function ${name} is security definer and has no search_path.`, {
      fix: { summary: "Set search_path on the function to the schemas it is allowed to see." },
    });
  }
  if (options.searchPath !== undefined && options.searchPath.trim().length > 0) {
    for (const part of options.searchPath.split(",")) {
      assertIdentifier(part.trim(), `function ${name} search_path`);
    }
  }
  const argTypes = (options.arguments ?? []).map((argument) => argument.type);
  const schema = options.schema ?? "public";
  return {
    name,
    schema,
    argTypes,
    contribute(peers, built) {
      assertPeers(peers, "functions");
      const namespace = staticNamespace(schema);
      const provenance: Provenance = { origin: "file", name };
      return [
        functionObject({
          namespace,
          name,
          ...(options.arguments !== undefined ? { arguments: options.arguments } : {}),
          returns: options.returns,
          language,
          ...(options.volatility !== undefined ? { volatility: options.volatility } : {}),
          ...(options.security !== undefined ? { security: options.security } : {}),
          ...(options.searchPath !== undefined ? { searchPath: options.searchPath } : {}),
          body,
          ...(atomic ? { atomic: true } : {}),
          provenance,
          dependencies: dependencyEdges(options.dependsOn, built),
        }),
      ];
    },
  };
}

/**
 * Declares a trigger.
 *
 * @param name - Trigger name, unique on its table
 * @param options - Table, timing, events, and the function it calls
 * @returns The definition object `schema({ triggers })` stores
 */
export function trigger(name: string, options: TriggerOptions): TriggerDeclaration {
  return {
    name,
    contribute(peers, built) {
      assertPeers(peers, "triggers");
      const parent = tableRef(options.on, built);
      const namespace = staticNamespace(options.calls.schema);
      const calls = {
        namespace,
        name: options.calls.name,
        argTypes: options.calls.argTypes,
      };
      if (!hasIdentity(built, { kind: "function", ...calls })) {
        throw new OkmError(
          "OKM1020",
          `Trigger ${name} calls ${options.calls.name}, which is not in the catalog.`,
          { fix: { summary: "List the function in schema({ functions }) before the trigger." } },
        );
      }
      for (const column of options.updateOf ?? []) {
        if (!hasIdentity(built, { kind: "column", parent, name: column })) {
          throw new OkmError(
            "OKM1020",
            `Trigger ${name} names column ${column}, which ${parent.name} does not have.`,
            { fix: { summary: "Name a column of the table the trigger is on." } },
          );
        }
      }
      return [
        triggerObject({
          parent,
          name,
          timing: options.timing,
          events: options.events,
          level: options.level,
          calls,
          ...(options.updateOf !== undefined ? { updateOf: options.updateOf } : {}),
          ...(options.when !== undefined ? { when: bodyText(options.when) } : {}),
          provenance: { origin: "file", name },
        }),
      ];
    },
  };
}

function bodyText(body: SqlText | string): string {
  return typeof body === "string" ? body : body.text;
}

function assertPeers(peers: unknown, option: "functions" | "triggers"): void {
  if (!Array.isArray(peers)) {
    throw new OkmError("OKM1020", `schema({ ${option} }) must be a list.`, {
      fix: { summary: `Pass an array to schema({ ${option} }).` },
    });
  }
}

function dependencyEdges(
  dependsOn: readonly DependsOn[] | undefined,
  built: unknown,
): readonly ObjectIdentity[] {
  if (dependsOn === undefined) return [];
  return dependsOn.map((item) => {
    if ("column" in item && "table" in item) {
      const parent = tableRef(item.table, built);
      const edge: ObjectIdentity = { kind: "column", parent, name: item.column };
      if (!hasIdentity(built, edge)) {
        throw new OkmError(
          "OKM1020",
          `dependsOn names column ${item.column}, which ${parent.name} does not have.`,
          { fix: { summary: "Name a column of a table in this schema." } },
        );
      }
      return edge;
    }
    const parent = tableRef(item, built);
    return { kind: "table", namespace: parent.namespace, name: parent.name };
  });
}

function tableRef(table: AnyTable, built: unknown): ObjectRef {
  if (!Array.isArray(built)) {
    throw new OkmError("OKM1020", `Table ${table.name} is not in the catalog.`, {
      fix: { summary: "List the table in schema({ tables })." },
    });
  }
  for (const object of built) {
    if (!isRecord(object) || object.kind !== "table") continue;
    const identity = object.identity;
    const provenance = object.provenance;
    if (!isRecord(identity) || !isRecord(provenance)) continue;
    if (
      provenance.origin === "file" &&
      provenance.name === table.name &&
      typeof identity.name === "string"
    ) {
      const namespace = identity.namespace;
      if (
        isRecord(namespace) &&
        namespace.form === "static" &&
        typeof namespace.name === "string"
      ) {
        return { namespace: staticNamespace(namespace.name), name: identity.name };
      }
    }
  }
  throw new OkmError("OKM1020", `Table ${table.name} is not in the catalog.`, {
    fix: { summary: "List the table in schema({ tables })." },
  });
}

function hasIdentity(built: unknown, identity: ObjectIdentity): boolean {
  if (!Array.isArray(built)) return false;
  for (const object of built) {
    if (!isRecord(object) || !isRecord(object.identity)) continue;
    if (same(object.identity, identity)) return true;
  }
  return false;
}

function same(left: Record<string, unknown>, right: ObjectIdentity): boolean {
  if (left.kind !== right.kind) return false;
  if (right.kind === "function") {
    return (
      left.name === right.name && JSON.stringify(left.argTypes) === JSON.stringify(right.argTypes)
    );
  }
  if (right.kind === "column") {
    const parent = left.parent;
    return left.name === right.name && isRecord(parent) && parent.name === right.parent.name;
  }
  if (right.kind === "table") return left.name === right.name;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
