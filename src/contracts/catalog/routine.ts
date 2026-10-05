/**
 * Function and trigger catalog objects.
 *
 * The factories store the record. They do not plan SQL. DDL stays in the
 * dialect, and `fn()` / `trigger()` stay on `okmodel/fn`.
 */

import { catalogError } from "../error.js";
import { assertIdentifier } from "./identifier.js";
import { assertNamespace, staticNamespace } from "./identity.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  FunctionArgument,
  FunctionDefinition,
  FunctionLanguage,
  FunctionObject,
  FunctionSecurity,
  FunctionVolatility,
  Namespace,
  ObjectIdentity,
  ObjectRef,
  Owner,
  Provenance,
  TriggerCall,
  TriggerDefinition,
  TriggerEvent,
  TriggerLevel,
  TriggerObject,
  TriggerTiming,
} from "./types.js";

/** Input for {@link functionObject}. */
export type FunctionInput = {
  readonly namespace?: Namespace;
  readonly name: string;
  readonly arguments?: readonly FunctionArgument[];
  readonly returns: string;
  readonly language: FunctionLanguage;
  readonly volatility?: FunctionVolatility;
  readonly security?: FunctionSecurity;
  readonly searchPath?: string;
  readonly body: string;
  readonly atomic?: boolean;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

/** Input for {@link triggerObject}. */
export type TriggerInput = {
  readonly parent: ObjectRef;
  readonly name: string;
  readonly timing: TriggerTiming;
  readonly events: readonly TriggerEvent[];
  readonly level: TriggerLevel;
  readonly calls: TriggerCall;
  readonly updateOf?: readonly string[];
  readonly when?: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

const VOLATILITY = new Set<FunctionVolatility>(["volatile", "stable", "immutable"]);
const SECURITY = new Set<FunctionSecurity>(["invoker", "definer"]);
const TIMING = new Set<TriggerTiming>(["before", "after", "instead"]);
const LEVEL = new Set<TriggerLevel>(["row", "statement"]);
const EVENT_ORDER: readonly TriggerEvent[] = ["insert", "update", "delete", "truncate"];
const TYPE_TEXT = /^[A-Za-z][A-Za-z0-9_ ]*(\(\d+(,\s*\d+)?\))?(\[\])*$/;

/**
 * Builds a function record.
 *
 * Argument types are the identity. Names live only in the definition.
 *
 * @param input - Signature, language, and body
 * @returns The catalog object
 */
export function functionObject(input: FunctionInput): FunctionObject {
  assertIdentifier(input.name, "function");
  const namespace = input.namespace ?? staticNamespace("public");
  assertNamespace(namespace);
  assertProvenance(input.provenance);
  if (input.language !== "sql" && input.language !== "plpgsql") {
    catalogError("OKM1020", `Function ${input.name} language must be sql or plpgsql.`);
  }
  const volatility = input.volatility ?? "volatile";
  if (!VOLATILITY.has(volatility)) {
    catalogError("OKM1020", `Function ${input.name} volatility ${volatility} is not supported.`);
  }
  const security = input.security ?? "invoker";
  if (!SECURITY.has(security)) {
    catalogError("OKM1020", `Function ${input.name} security ${security} is not supported.`);
  }
  assertTypeName(input.returns, `function ${input.name} return type`);
  const args = (input.arguments ?? []).map((argument) => readArgument(input.name, argument));
  if (input.body.length === 0) {
    catalogError("OKM1020", `Function ${input.name} needs a body.`);
  }
  const atomic = input.atomic === true;
  if (atomic && input.language !== "sql") {
    catalogError("OKM1020", `Function ${input.name} BEGIN ATOMIC needs language sql.`);
  }
  if (input.searchPath !== undefined && input.searchPath.trim().length === 0) {
    catalogError("OKM1020", `Function ${input.name} search_path is empty.`);
  }
  const definition: FunctionDefinition = {
    arguments: args,
    returns: input.returns,
    language: input.language,
    volatility,
    security,
    body: input.body,
    ...(input.searchPath !== undefined ? { searchPath: input.searchPath } : {}),
    ...(atomic ? { atomic: true } : {}),
  };
  return {
    kind: "function",
    identity: {
      kind: "function",
      namespace,
      name: input.name,
      argTypes: args.map((arg) => arg.type),
    },
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
}

/**
 * Builds a trigger record.
 *
 * Dependencies are the table, the function, and each `UPDATE OF` column.
 * Events are stored in a fixed order.
 *
 * @param input - Timing, events, and the function it calls
 * @returns The catalog object
 */
export function triggerObject(input: TriggerInput): TriggerObject {
  assertIdentifier(input.name, "trigger");
  assertNamespace(input.parent.namespace);
  assertIdentifier(input.parent.name, "trigger table");
  assertProvenance(input.provenance);
  if (!TIMING.has(input.timing)) {
    catalogError("OKM1020", `Trigger ${input.name} timing ${input.timing} is not supported.`);
  }
  if (!LEVEL.has(input.level)) {
    catalogError("OKM1020", `Trigger ${input.name} level ${input.level} is not supported.`);
  }
  const events = EVENT_ORDER.filter((event) => input.events.includes(event));
  if (events.length === 0) {
    catalogError("OKM1020", `Trigger ${input.name} needs an event.`);
  }
  const updateOf = input.updateOf === undefined ? undefined : [...input.updateOf];
  if (updateOf !== undefined) {
    if (!events.includes("update")) {
      catalogError(
        "OKM1020",
        `Trigger ${input.name} lists UPDATE OF columns without an update event.`,
      );
    }
    if (input.level !== "row") {
      catalogError("OKM1020", `Trigger ${input.name} UPDATE OF columns need level row.`);
    }
    for (const column of updateOf) assertIdentifier(column, "trigger column");
  }
  assertIdentifier(input.calls.name, "trigger function");
  assertNamespace(input.calls.namespace);
  for (const typeName of input.calls.argTypes) assertTypeName(typeName, `trigger ${input.name}`);
  const edges: ObjectIdentity[] = [
    { kind: "table", namespace: input.parent.namespace, name: input.parent.name },
    {
      kind: "function",
      namespace: input.calls.namespace,
      name: input.calls.name,
      argTypes: input.calls.argTypes,
    },
    ...(updateOf ?? []).map((column): ObjectIdentity => ({
      kind: "column",
      parent: input.parent,
      name: column,
    })),
    ...(input.dependencies ?? []),
  ];
  const definition: TriggerDefinition = {
    timing: input.timing,
    events,
    level: input.level,
    calls: {
      namespace: input.calls.namespace,
      name: input.calls.name,
      argTypes: [...input.calls.argTypes],
    },
    ...(updateOf !== undefined && updateOf.length > 0 ? { updateOf } : {}),
    ...(input.when !== undefined && input.when.length > 0 ? { when: input.when } : {}),
  };
  return {
    kind: "trigger",
    identity: { kind: "trigger", parent: input.parent, name: input.name },
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(edges),
    provenance: input.provenance,
  };
}

function readArgument(fn: string, argument: FunctionArgument): FunctionArgument {
  assertIdentifier(argument.name, `function ${fn} argument`);
  assertTypeName(argument.type, `function ${fn} argument ${argument.name}`);
  return { name: argument.name, type: argument.type };
}

function assertTypeName(typeName: string, role: string): void {
  if (!TYPE_TEXT.test(typeName)) {
    catalogError("OKM1020", `${role} ${typeName} is not a type name.`);
  }
}
