/**
 * A catalog that contains every object kind this spike models.
 */

import { quoteIdent } from "./sql.js";
import {
  type CatalogObject,
  type DependencyEdge,
  type NamespaceName,
  type ObjectIdentity,
  type Provenance,
} from "./object.js";

const provenance: Provenance = { source: "spike" };

/**
 * Builds the sample catalog in one namespace.
 *
 * The namespace may be static or a template. SQL text quotes that namespace;
 * rendering substitutes the concrete schema.
 *
 * @param namespace - Logical namespace for every schema-scoped object
 * @returns One object of each kind, plus the objects they depend on
 */
export function sampleCatalog(namespace: NamespaceName): readonly CatalogObject[] {
  const email = domain(namespace, "email", "text", false);
  const taskSeq = sequence(namespace, "task_seq");
  const tasks = table(namespace, "tasks", true, undefined, [email.identity]);
  const taskId = column(namespace, "tasks", "id", "int8", false);
  const taskTitle = column(namespace, "tasks", "title", "text", false);
  const taskEmail = column(namespace, "tasks", "email", "email", true, undefined, [email.identity]);
  const taskRank = column(namespace, "tasks", "rank", "int8", false, "0");
  const taskPk = primaryKey(namespace, "tasks", "tasks_pkey", ["id"]);
  const taskEmailKey = unique(namespace, "tasks", "tasks_email_key", ["email"], true);
  const taskCheck = check(namespace, "tasks", "tasks_id_check", ["id"], "id > 0");
  const titleIdx = index(namespace, "tasks", "tasks_title_idx", ["title"]);
  const events = table(namespace, "events", false, { method: "range", columns: ["id"] });
  const eventId = column(namespace, "events", "id", "int8", false);
  const eventLabel = column(namespace, "events", "label", "text", false);
  const eventPk = primaryKey(namespace, "events", "events_pkey", ["id"]);
  const low = partition(namespace, "events_low", "events", "0", "100");
  const high = partition(namespace, "events_high", "events", "100", "1000");
  const child = table(namespace, "child", false);
  const childId = column(namespace, "child", "id", "int8", false);
  const childParent = column(namespace, "child", "parent_id", "int8", false);
  const childPk = primaryKey(namespace, "child", "child_pkey", ["id"]);
  const childFk = foreignKey(
    namespace,
    "child",
    "child_parent_fkey",
    ["parent_id"],
    "tasks",
    ["id"],
    [tasks.identity],
  );
  const slugText = fn(
    namespace,
    "slug",
    [{ name: "input", type: "text" }],
    "text",
    "sql",
    "immutable",
    "return",
    "lower(input);",
  );
  const slugInt = fn(
    namespace,
    "slug",
    [{ name: "input", type: "int8" }],
    "int8",
    "sql",
    "immutable",
    "return",
    "input;",
  );
  const touch = fn(
    namespace,
    "touch",
    [],
    "trigger",
    "plpgsql",
    "volatile",
    "string",
    `begin\n  perform 1 from ${q(namespace, "tasks")} where id = new.id;\n  return new;\nend`,
    [tasks.identity],
  );
  const taskCount = fn(
    namespace,
    "task_count",
    [],
    "int8",
    "sql",
    "stable",
    "atomic",
    `select count(*)::int8 from ${q(namespace, "tasks")};`,
    [tasks.identity],
  );
  const touchTrigger = trigger(namespace, "tasks_touch", "tasks", "touch", [
    tasks.identity,
    touch.identity,
  ]);
  const active = view(
    namespace,
    "active_tasks",
    ["id", "title"],
    `select "id", "title" from ${q(namespace, "tasks")} where "id" > 0`,
    [tasks.identity, taskId.identity, taskTitle.identity],
  );
  const titles = materializedView(
    namespace,
    "task_titles",
    ["title"],
    `select "title" from ${q(namespace, "tasks")}`,
    [tasks.identity, taskTitle.identity],
  );
  const read = policy(namespace, "tasks_read", "tasks", [tasks.identity]);
  return [
    email,
    taskSeq,
    tasks,
    taskId,
    taskTitle,
    taskEmail,
    taskRank,
    taskPk,
    taskEmailKey,
    taskCheck,
    titleIdx,
    events,
    eventId,
    eventLabel,
    eventPk,
    low,
    high,
    child,
    childId,
    childParent,
    childPk,
    childFk,
    slugText,
    slugInt,
    touch,
    taskCount,
    touchTrigger,
    active,
    titles,
    read,
  ];
}

/**
 * An extension object. Extensions have no namespace.
 *
 * @returns A catalog whose only object is `citext`
 */
export function extensionCatalog(): readonly CatalogObject[] {
  return [
    {
      kind: "extension",
      identity: { kind: "extension", name: "citext" },
      owner: "managed",
      definition: { name: "citext" },
      dependencies: [],
      provenance,
    },
  ];
}

function q(namespace: NamespaceName, name: string): string {
  return `${quoteIdent(namespace.name)}.${quoteIdent(name)}`;
}

function edges(identities: readonly ObjectIdentity[]): readonly DependencyEdge[] {
  return identities.map((identity) => ({ identity }));
}

function domain(
  namespace: NamespaceName,
  name: string,
  baseType: string,
  notNull: boolean,
): CatalogObject {
  return {
    kind: "domain",
    identity: { kind: "domain", namespace, name },
    owner: "managed",
    definition: { baseType, notNull },
    dependencies: [],
    provenance,
  };
}

function sequence(namespace: NamespaceName, name: string): CatalogObject {
  return {
    kind: "sequence",
    identity: { kind: "sequence", namespace, name },
    owner: "managed",
    definition: { dataType: "int8", start: "1", increment: "1" },
    dependencies: [],
    provenance,
  };
}

function table(
  namespace: NamespaceName,
  name: string,
  rowSecurity: boolean,
  partitionBy?: { readonly method: "range"; readonly columns: readonly string[] },
  dependencies: readonly ObjectIdentity[] = [],
): CatalogObject {
  return {
    kind: "table",
    identity: { kind: "table", namespace, name },
    owner: "managed",
    definition: partitionBy === undefined ? { rowSecurity } : { rowSecurity, partitionBy },
    dependencies: edges(dependencies),
    provenance,
  };
}

function column(
  namespace: NamespaceName,
  parent: string,
  name: string,
  type: string,
  nullable: boolean,
  defaultSql?: string,
  extra: readonly ObjectIdentity[] = [],
): CatalogObject {
  return {
    kind: "column",
    identity: { kind: "column", namespace, parent, name },
    owner: "managed",
    definition: defaultSql === undefined ? { type, nullable } : { type, nullable, defaultSql },
    dependencies: edges([{ kind: "table", namespace, name: parent }, ...extra]),
    provenance,
  };
}

function primaryKey(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
): CatalogObject {
  return constraint(namespace, parent, name, {
    constraintKind: "primary_key",
    columns,
    deferrable: false,
    initially: "immediate",
    nullsNotDistinct: false,
  });
}

function unique(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
  nullsNotDistinct: boolean,
): CatalogObject {
  return constraint(namespace, parent, name, {
    constraintKind: "unique",
    columns,
    deferrable: false,
    initially: "immediate",
    nullsNotDistinct,
  });
}

function check(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
  expression: string,
): CatalogObject {
  return constraint(namespace, parent, name, {
    constraintKind: "check",
    columns,
    expression,
    deferrable: false,
    initially: "immediate",
    nullsNotDistinct: false,
  });
}

function foreignKey(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
  refTable: string,
  refColumns: readonly string[],
  extra: readonly ObjectIdentity[],
): CatalogObject {
  return constraint(
    namespace,
    parent,
    name,
    {
      constraintKind: "foreign_key",
      columns,
      references: { table: refTable, columns: refColumns },
      deferrable: true,
      initially: "deferred",
      nullsNotDistinct: false,
    },
    extra,
  );
}

function constraint(
  namespace: NamespaceName,
  parent: string,
  name: string,
  definition: Extract<CatalogObject, { kind: "constraint" }>["definition"],
  extra: readonly ObjectIdentity[] = [],
): CatalogObject {
  return {
    kind: "constraint",
    identity: { kind: "constraint", namespace, parent, name },
    owner: "managed",
    definition,
    dependencies: edges([{ kind: "table", namespace, name: parent }, ...extra]),
    provenance,
  };
}

function index(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
): CatalogObject {
  return {
    kind: "index",
    identity: { kind: "index", namespace, parent, name },
    owner: "managed",
    definition: { columns, unique: false },
    dependencies: edges([{ kind: "table", namespace, name: parent }]),
    provenance,
  };
}

function partition(
  namespace: NamespaceName,
  name: string,
  parent: string,
  from: string,
  to: string,
): CatalogObject {
  return {
    kind: "partition",
    identity: { kind: "partition", namespace, parent, name },
    owner: "managed",
    definition: { parent, from, to },
    dependencies: edges([{ kind: "table", namespace, name: parent }]),
    provenance,
  };
}

function fn(
  namespace: NamespaceName,
  name: string,
  args: readonly { readonly name: string; readonly type: string }[],
  returns: string,
  language: "sql" | "plpgsql",
  volatility: "immutable" | "stable" | "volatile",
  bodyStyle: "string" | "return" | "atomic",
  body: string,
  dependencies: readonly ObjectIdentity[] = [],
): CatalogObject {
  return {
    kind: "function",
    identity: { kind: "function", namespace, name, argTypes: args.map((arg) => arg.type) },
    owner: "managed",
    definition: { args, returns, language, volatility, body, bodyStyle },
    dependencies: edges(dependencies),
    provenance,
  };
}

function trigger(
  namespace: NamespaceName,
  name: string,
  parent: string,
  functionName: string,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  return {
    kind: "trigger",
    identity: { kind: "trigger", namespace, parent, name },
    owner: "managed",
    definition: {
      timing: "before",
      events: ["update"],
      level: "row",
      function: functionName,
      functionArgTypes: [],
    },
    dependencies: edges(dependencies),
    provenance,
  };
}

function view(
  namespace: NamespaceName,
  name: string,
  columns: readonly string[],
  sql: string,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  return {
    kind: "view",
    identity: { kind: "view", namespace, name },
    owner: "managed",
    definition: { sql, columns },
    dependencies: edges(dependencies),
    provenance,
  };
}

function materializedView(
  namespace: NamespaceName,
  name: string,
  columns: readonly string[],
  sql: string,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  return {
    kind: "materialized_view",
    identity: { kind: "materialized_view", namespace, name },
    owner: "managed",
    definition: { sql, columns, withData: false },
    dependencies: edges(dependencies),
    provenance,
  };
}

function policy(
  namespace: NamespaceName,
  name: string,
  parent: string,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  return {
    kind: "policy",
    identity: { kind: "policy", namespace, parent, name },
    owner: "managed",
    definition: { command: "select", permissive: true, using: "true", check: "" },
    dependencies: edges(dependencies),
    provenance,
  };
}
