/**
 * Plans `fn()`, `trigger()`, `view()`, and `materializedView()` for `okm pull`.
 *
 * Views and `BEGIN ATOMIC` bodies take edges the catalog already read from
 * `pg_depend`. A plpgsql or SQL-string body gets table candidates from
 * {@link sqlIdentifiers}. A view or a function named in that body is an
 * ordering edge only: `dependsOn` accepts tables and columns. A view query
 * is matched the same way, so a view over a view waits for the view it names
 * when `pg_depend` recorded no column edge.
 */

import { identityKey, staticNamespace } from "../../contracts/catalog/identity.js";
import type {
  Catalog,
  CatalogObject,
  FunctionObject,
  IndexObject,
  MaterializedViewObject,
  ObjectIdentity,
  TriggerObject,
  ViewObject,
} from "../../contracts/catalog/types.js";
import { sqlIdentifiers } from "./sql-lex.js";

/** Why a pulled routine is marked the way it is. */
export type RoutineStatus = "verified" | "candidate-only" | "unverified";

/** One function, trigger, or view after the scratch replay. */
export type RoutineVerdict = {
  /** {@link identityKey} of the catalog object. */
  readonly key: string;
  /** Catalog kind. */
  readonly kind: "function" | "trigger" | "view" | "materializedView";
  /** Report label. */
  readonly label: string;
  /** What the scratch run proved. */
  readonly status: RoutineStatus;
  /** Postgres error, or why the scratch schema did not run. Empty when proved or candidate-only. */
  readonly detail: string;
};

/** One object the schema file does not declare. Shape matches the pull skip. */
export type RoutineSkip = {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly reason: string;
  readonly sql: string;
};

/** A function the schema file will declare. */
export type PlannedFunction = {
  readonly object: FunctionObject;
  /** Binding in the schema file. */
  readonly binding: string;
  /** Source fragments inside `dependsOn: [...]`. */
  readonly dependsOn: readonly string[];
};

/** A trigger the schema file will declare. */
export type PlannedTrigger = {
  readonly object: TriggerObject;
  readonly binding: string;
  /** Table binding passed to `on`. */
  readonly on: string;
  /** Function binding passed to `calls`. */
  readonly calls: string;
};

/** A view or materialized view the schema file will declare. */
export type PlannedView = {
  readonly object: ViewObject | MaterializedViewObject;
  readonly binding: string;
  /** Indexes `materializedView()` can store. Expression indexes are skipped. */
  readonly indexes: readonly IndexObject[];
};

/**
 * Routines to write, and the extra edges the scratch replay orders by.
 *
 * `orderEdges` are not written. `dependsOn` cannot name a view or a function.
 */
export type RoutinePlan = {
  readonly functions: readonly PlannedFunction[];
  readonly triggers: readonly PlannedTrigger[];
  readonly views: readonly PlannedView[];
  readonly skipped: readonly RoutineSkip[];
  /** Identity key to edges added for the scratch order only. */
  readonly orderEdges: ReadonlyMap<string, readonly ObjectIdentity[]>;
};

/** Bindings and declarations inserted into the schema file. */
export type RenderedRoutines = {
  readonly imports: readonly string[];
  readonly body: string;
  readonly functions: readonly string[];
  readonly triggers: readonly string[];
  readonly views: readonly string[];
};

const BINDING_SEED = ["schema", "extension", "fn", "trigger", "view", "materializedView"];

/**
 * Chooses which routines to write and which names `dependsOn` can cite.
 *
 * @param source - Introspected catalog
 * @param tableExports - SQL table name to the binding `table()` writes
 * @returns The plan. Comments are applied later, from the scratch verdicts
 */
export function planRoutines(
  source: Catalog,
  tableExports: ReadonlyMap<string, string>,
): RoutinePlan {
  const namespace = staticNamespace("public");
  const used = new Set<string>([...BINDING_SEED, ...tableExports.values()]);
  const tables = new Map<string, ObjectIdentity>();
  for (const name of tableExports.keys()) {
    tables.set(name, { kind: "table", namespace, name });
  }
  const functions = source.objects.filter(
    (object): object is FunctionObject => object.kind === "function",
  );
  const functionByName = new Map<string, FunctionObject[]>();
  for (const object of functions) {
    const list = functionByName.get(object.identity.name) ?? [];
    list.push(object);
    functionByName.set(object.identity.name, list);
  }
  const views = source.objects.filter(
    (object): object is ViewObject | MaterializedViewObject =>
      object.kind === "view" || object.kind === "materializedView",
  );
  const viewByName = new Map<string, ViewObject | MaterializedViewObject>();
  for (const object of views) viewByName.set(object.identity.name, object);

  const skipped: RoutineSkip[] = [];
  const plannedFunctions: PlannedFunction[] = [];
  const pulledFunctions = new Map<string, PlannedFunction>();
  const orderEdges = new Map<string, ObjectIdentity[]>();

  const sortedFunctions = [...functions].sort((left, right) =>
    compare(
      `${left.identity.name}\0${left.identity.argTypes.join(",")}`,
      `${right.identity.name}\0${right.identity.argTypes.join(",")}`,
    ),
  );
  for (const object of sortedFunctions) {
    const label = functionLabel(object);
    if (
      object.definition.security === "definer" &&
      (object.definition.searchPath === undefined || object.definition.searchPath.length === 0)
    ) {
      skipped.push(
        skip(
          object,
          label,
          "security definer without search_path is OKM1823",
          object.definition.body,
        ),
      );
      continue;
    }
    const binding = freshBinding(object.identity.name, used);
    const atomic = object.definition.atomic === true;
    const dependsOn: string[] = [];
    const edges: ObjectIdentity[] = [];
    if (atomic) {
      for (const edge of object.dependencies) {
        const fragment = dependFragment(edge.target, tableExports);
        if (fragment === undefined) continue;
        dependsOn.push(fragment);
      }
    } else {
      const matched = matchNames(object.definition.body, tables, viewByName, functionByName);
      for (const name of matched.tables) {
        const exportName = tableExports.get(name);
        const identity = tables.get(name);
        if (exportName === undefined || identity === undefined) continue;
        dependsOn.push(exportName);
        edges.push(identity);
      }
      for (const identity of matched.views) edges.push(identity);
      for (const identity of matched.functions) {
        if (identityKey(identity) === identityKey(object.identity)) continue;
        edges.push(identity);
      }
    }
    if (edges.length > 0) orderEdges.set(identityKey(object.identity), edges);
    const planned: PlannedFunction = { object, binding, dependsOn };
    plannedFunctions.push(planned);
    pulledFunctions.set(identityKey(object.identity), planned);
  }

  const plannedTriggers: PlannedTrigger[] = [];
  const triggers = source.objects.filter(
    (object): object is TriggerObject => object.kind === "trigger",
  );
  for (const object of [...triggers].sort((left, right) =>
    compare(
      `${left.identity.parent.name}.${left.identity.name}`,
      `${right.identity.parent.name}.${right.identity.name}`,
    ),
  )) {
    const label = `${object.identity.parent.name}.${object.identity.name}`;
    const tableBinding = tableExports.get(object.identity.parent.name);
    if (tableBinding === undefined) {
      skipped.push(skip(object, label, "the table was not pulled", ""));
      continue;
    }
    const callKey = identityKey({
      kind: "function",
      namespace: object.definition.calls.namespace,
      name: object.definition.calls.name,
      argTypes: object.definition.calls.argTypes,
    });
    const call = pulledFunctions.get(callKey);
    if (call === undefined) {
      skipped.push(skip(object, label, "the function was not pulled", ""));
      continue;
    }
    const binding = freshBinding(object.identity.name, used);
    plannedTriggers.push({ object, binding, on: tableBinding, calls: call.binding });
  }

  const indexes = source.objects.filter((object): object is IndexObject => object.kind === "index");
  const plannedViews: PlannedView[] = [];
  for (const object of [...views].sort((left, right) =>
    compare(left.identity.name, right.identity.name),
  )) {
    if (object.kind === "view" && object.definition.securityInvoker === true) {
      skipped.push(
        skip(
          object,
          object.identity.name,
          "view() sets security_invoker from tenancy, and pull does not declare tenancy",
          object.definition.query,
        ),
      );
      continue;
    }
    const owned = indexes.filter((index) => index.identity.parent.name === object.identity.name);
    const kept: IndexObject[] = [];
    if (object.kind === "materializedView") {
      for (const index of [...owned].sort((left, right) =>
        compare(left.identity.name, right.identity.name),
      )) {
        if (
          index.definition.columns.length === 0 ||
          index.definition.expression !== undefined ||
          index.definition.predicate !== undefined
        ) {
          skipped.push(
            skip(
              index,
              `${object.identity.name}.${index.identity.name}`,
              "materializedView() stores a column index, not an expression or a predicate",
              "",
            ),
          );
          continue;
        }
        kept.push(index);
      }
    }
    const matched = matchNames(object.definition.query, tables, viewByName, functionByName);
    const self = identityKey(object.identity);
    const edges: ObjectIdentity[] = [];
    for (const name of matched.tables) {
      const identity = tables.get(name);
      if (identity !== undefined) edges.push(identity);
    }
    for (const identity of matched.views) {
      if (identityKey(identity) !== self) edges.push(identity);
    }
    for (const identity of matched.functions) {
      if (identityKey(identity) !== self) edges.push(identity);
    }
    if (edges.length > 0) orderEdges.set(self, edges);
    plannedViews.push({
      object,
      binding: freshBinding(object.identity.name, used),
      indexes: kept,
    });
  }

  return {
    functions: plannedFunctions,
    triggers: plannedTriggers,
    views: plannedViews,
    skipped,
    orderEdges,
  };
}

/**
 * Renders the schema-file text for a plan.
 *
 * A missing verdict is candidate-only for a function and unverified for a
 * view or a trigger. That is what a scratch run that did not happen can say.
 *
 * @param plan - Routines to write
 * @param verdicts - Scratch results, keyed by {@link identityKey}
 * @returns Imports, bindings, and the `schema()` lists
 */
export function renderRoutines(
  plan: RoutinePlan,
  verdicts: ReadonlyMap<string, RoutineVerdict>,
): RenderedRoutines {
  const imports: string[] = [];
  if (plan.functions.length > 0 || plan.triggers.length > 0) {
    const names = [];
    if (plan.functions.length > 0) names.push("fn");
    if (plan.triggers.length > 0) names.push("trigger");
    imports.push(`import { ${names.join(", ")} } from "okmodel/fn";`);
  }
  if (plan.views.length > 0) {
    const hasView = plan.views.some((item) => item.object.kind === "view");
    const hasMat = plan.views.some((item) => item.object.kind === "materializedView");
    const names = [];
    if (hasMat) names.push("materializedView");
    if (hasView) names.push("view");
    imports.push(`import { ${names.join(", ")} } from "okmodel/view";`);
  }
  const lines: string[] = [];
  for (const item of plan.functions) {
    lines.push(commentFor(verdicts.get(identityKey(item.object.identity)), "function"));
    lines.push(functionSource(item));
    lines.push("");
  }
  for (const item of plan.triggers) {
    lines.push(commentFor(verdicts.get(identityKey(item.object.identity)), "trigger"));
    lines.push(triggerSource(item));
    lines.push("");
  }
  for (const item of plan.views) {
    lines.push(
      commentFor(
        verdicts.get(identityKey(item.object.identity)),
        item.object.kind === "materializedView" ? "materializedView" : "view",
      ),
    );
    lines.push(viewSource(item));
    lines.push("");
  }
  return {
    imports,
    body: lines.join("\n"),
    functions: plan.functions.map((item) => item.binding),
    triggers: plan.triggers.map((item) => item.binding),
    views: plan.views.map((item) => item.binding),
  };
}

/**
 * Verdicts for a plan when the scratch schema was not created.
 *
 * Nothing is verified. A plpgsql function stays candidate-only. A SQL
 * function, a view, and a trigger are unverified.
 *
 * @param plan - Routines that would have been replayed
 * @param detail - Why the scratch schema was not created
 * @returns One verdict per planned routine
 */
export function verdictsWithoutScratch(
  plan: RoutinePlan,
  detail: string,
): readonly RoutineVerdict[] {
  const verdicts: RoutineVerdict[] = [];
  for (const item of plan.functions) {
    const plpgsql = item.object.definition.language === "plpgsql";
    verdicts.push({
      key: identityKey(item.object.identity),
      kind: "function",
      label: functionLabel(item.object),
      status: plpgsql ? "candidate-only" : "unverified",
      detail,
    });
  }
  for (const item of plan.triggers) {
    verdicts.push({
      key: identityKey(item.object.identity),
      kind: "trigger",
      label: `${item.object.identity.parent.name}.${item.object.identity.name}`,
      status: "unverified",
      detail,
    });
  }
  for (const item of plan.views) {
    verdicts.push({
      key: identityKey(item.object.identity),
      kind: item.object.kind,
      label: item.object.identity.name,
      status: "unverified",
      detail,
    });
  }
  return verdicts;
}

/**
 * Tables, views, and functions named in `body`.
 *
 * Unquoted names fold to lower case. A quoted name matches the stored spelling.
 * The function's own name is included; the caller drops a self-edge.
 *
 * @param body - Function body or view query
 * @param tables - Pulled tables
 * @param views - Pulled views and materialized views
 * @param functions - Functions grouped by name
 * @returns Matches, tables by SQL name and the other two as identities
 */
export function matchNames(
  body: string,
  tables: ReadonlyMap<string, ObjectIdentity>,
  views: ReadonlyMap<string, ViewObject | MaterializedViewObject>,
  functions: ReadonlyMap<string, readonly FunctionObject[]>,
): {
  readonly tables: readonly string[];
  readonly views: readonly ObjectIdentity[];
  readonly functions: readonly ObjectIdentity[];
} {
  const tableHits = new Set<string>();
  const viewHits = new Map<string, ObjectIdentity>();
  const functionHits = new Map<string, ObjectIdentity>();
  for (const name of sqlIdentifiers(body)) {
    if (name.quoted) {
      const table = tables.get(name.text);
      if (table !== undefined) tableHits.add(name.text);
      const view = views.get(name.text);
      if (view !== undefined) viewHits.set(identityKey(view.identity), view.identity);
      for (const fn of functions.get(name.text) ?? []) {
        functionHits.set(identityKey(fn.identity), fn.identity);
      }
      continue;
    }
    const folded = name.text.toLowerCase();
    for (const [table, identity] of tables) {
      if (table.toLowerCase() === folded) {
        tableHits.add(table);
        void identity;
      }
    }
    for (const [viewName, view] of views) {
      if (viewName.toLowerCase() === folded)
        viewHits.set(identityKey(view.identity), view.identity);
    }
    for (const [fnName, list] of functions) {
      if (fnName.toLowerCase() !== folded) continue;
      for (const fn of list) functionHits.set(identityKey(fn.identity), fn.identity);
    }
  }
  return {
    tables: [...tableHits].sort(compare),
    views: [...viewHits.values()],
    functions: [...functionHits.values()],
  };
}

function dependFragment(
  target: ObjectIdentity,
  tableExports: ReadonlyMap<string, string>,
): string | undefined {
  if (target.kind === "table") {
    const binding = tableExports.get(target.name);
    return binding;
  }
  if (target.kind === "column") {
    const binding = tableExports.get(target.parent.name);
    if (binding === undefined) return undefined;
    return `{ table: ${binding}, column: ${JSON.stringify(target.name)} }`;
  }
  return undefined;
}

function functionSource(item: PlannedFunction): string {
  const definition = item.object.definition;
  const fields = [
    definition.arguments.length > 0
      ? `arguments: [${definition.arguments
          .map(
            (argument) =>
              `{ name: ${JSON.stringify(argument.name)}, type: ${JSON.stringify(argument.type)} }`,
          )
          .join(", ")}]`
      : "",
    `returns: ${JSON.stringify(definition.returns)}`,
    `language: ${JSON.stringify(definition.language)}`,
    definition.volatility !== "volatile"
      ? `volatility: ${JSON.stringify(definition.volatility)}`
      : "",
    definition.security === "definer" ? `security: "definer"` : "",
    definition.searchPath !== undefined
      ? `searchPath: ${JSON.stringify(definition.searchPath)}`
      : "",
    `body: ${JSON.stringify(definition.body)}`,
    item.dependsOn.length > 0 || definition.language === "plpgsql"
      ? `dependsOn: [${item.dependsOn.join(", ")}]`
      : "",
  ].filter((field) => field.length > 0);
  return `const ${item.binding} = fn(${JSON.stringify(item.object.identity.name)}, {\n  ${fields.join(",\n  ")},\n});`;
}

function triggerSource(item: PlannedTrigger): string {
  const definition = item.object.definition;
  const fields = [
    `on: ${item.on}`,
    `timing: ${JSON.stringify(definition.timing)}`,
    `events: [${definition.events.map((event) => JSON.stringify(event)).join(", ")}]`,
    `level: ${JSON.stringify(definition.level)}`,
    definition.updateOf !== undefined
      ? `updateOf: [${definition.updateOf.map((column) => JSON.stringify(column)).join(", ")}]`
      : "",
    definition.when !== undefined ? `when: ${JSON.stringify(definition.when)}` : "",
    `calls: ${item.calls}`,
  ].filter((field) => field.length > 0);
  return `const ${item.binding} = trigger(${JSON.stringify(item.object.identity.name)}, {\n  ${fields.join(",\n  ")},\n});`;
}

function viewSource(item: PlannedView): string {
  const definition = item.object.definition;
  const columns = definition.columns
    .map(
      (column) =>
        `{ name: ${JSON.stringify(column.name)}, type: ${JSON.stringify(column.dataType)} }`,
    )
    .join(", ");
  const fields = [`columns: [${columns}]`, `query: ${JSON.stringify(definition.query)}`];
  if (item.object.kind === "materializedView" && item.indexes.length > 0) {
    const indexes = item.indexes
      .map((index) => {
        const parts = [
          `name: ${JSON.stringify(index.identity.name)}`,
          `columns: [${index.definition.columns.map((column) => JSON.stringify(column)).join(", ")}]`,
        ];
        if (index.definition.unique) parts.push("unique: true");
        return `{ ${parts.join(", ")} }`;
      })
      .join(", ");
    fields.push(`indexes: [${indexes}]`);
  }
  const call = item.object.kind === "materializedView" ? "materializedView" : "view";
  return `const ${item.binding} = ${call}(${JSON.stringify(item.object.identity.name)}, {\n  ${fields.join(",\n  ")},\n});`;
}

function commentFor(verdict: RoutineVerdict | undefined, kind: RoutineVerdict["kind"]): string {
  const status = verdict?.status ?? (kind === "function" ? "candidate-only" : "unverified");
  if (status === "verified" && kind === "function") {
    return "// verified: scratch replay created this function with check_function_bodies on.";
  }
  if (status === "verified" && kind === "trigger") {
    return "// verified: scratch replay created this trigger.";
  }
  if (status === "verified") {
    return "// verified: scratch replay created this view.";
  }
  if (status === "candidate-only") {
    return "// candidate-only: a plpgsql body is not proved by creation. dependsOn is a lexical match.";
  }
  if (kind === "function") return "// unverified: scratch replay did not create this function.";
  if (kind === "trigger") return "// unverified: scratch replay did not create this trigger.";
  return "// unverified: scratch replay did not create this view.";
}

function functionLabel(object: FunctionObject): string {
  return `${object.identity.name}(${object.identity.argTypes.join(", ")})`;
}

function skip(object: CatalogObject, label: string, reason: string, sql: string): RoutineSkip {
  return { key: identityKey(object.identity), kind: object.kind, label, reason, sql };
}

function freshBinding(sql: string, used: Set<string>): string {
  const base = avoidImportBinding(bindingIdent(sql));
  let name = base;
  let salt = 2;
  while (used.has(name)) {
    name = `${base}_${String(salt)}`;
    salt += 1;
  }
  used.add(name);
  return name;
}

/**
 * Bindings that pulled files import from okmodel.
 *
 * A table, column, or routine with one of these names is written as
 * `${name}Name`. The import stays, so `export const t = table(...)` cannot
 * shadow `t` and throw before initialization.
 */
const PULL_IMPORTS = new Set([
  "columns",
  "extension",
  "fn",
  "index",
  "materializedView",
  "schema",
  "sql",
  "t",
  "table",
  "trigger",
  "view",
]);

export function avoidImportBinding(name: string): string {
  return PULL_IMPORTS.has(name) ? `${name}Name` : name;
}

function bindingIdent(sql: string): string {
  let out = "";
  for (const char of sql) {
    const ok =
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      (char >= "0" && char <= "9") ||
      char === "_";
    out += ok ? char : "_";
  }
  if (out.length === 0) out = "routine";
  const first = out[0] ?? "";
  if (first >= "0" && first <= "9") out = `r_${out}`;
  if (BINDING_RESERVED.has(out)) out = `${out}Name`;
  return out;
}

const BINDING_RESERVED = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
