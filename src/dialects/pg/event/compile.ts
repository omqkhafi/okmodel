/**
 * Compiles `trigger({ event })` into catalog objects.
 *
 * Loaded only from `okmodel/event`. A schema that never imports that path
 * does not load this file.
 */

import { eventTriggerObject } from "../../../contracts/catalog/event-trigger.js";
import { OkmError } from "../../../contracts/error.js";
import { table as catalogTable } from "../../../contracts/catalog/object.js";
import type { CatalogObject, FunctionObject } from "../../../contracts/catalog/types.js";
import type { EventCompiler, EventDeclaration, EventTriggerOptions } from "./slot.js";
import { normaliseTags, readEnabled, readEvent } from "./tags.js";

/**
 * The compiler `okmodel/event` installs.
 */
export const eventCompiler: EventCompiler = {
  declaration,
  stampRls,
};

/**
 * One `trigger({ event })` declaration.
 *
 * @param name - Database-wide name
 * @param options - Event, tags, function, and enabled mode
 * @returns The object `schema({ triggers })` stores
 */
function declaration(name: string, options: EventTriggerOptions): EventDeclaration {
  const event = readEvent(name, options.event);
  const tags = normaliseTags(name, options.tags);
  const enabled = readEnabled(options.enabled);
  return {
    name,
    event,
    contribute(_peers, built) {
      const objects = asObjects(built);
      const fn = requireEventFunction(name, options.calls, objects);
      return [
        eventTriggerObject({
          name,
          event,
          enabled,
          ...(tags !== undefined ? { tags } : {}),
          calls: {
            namespace: fn.identity.namespace,
            name: fn.identity.name,
            argTypes: [],
          },
          provenance: { origin: "file", name },
          ...(options.comment !== undefined ? { comment: options.comment } : {}),
        }),
      ];
    },
  };
}

/**
 * Makes `rls` the default for tables in the schemas `enableRls` named.
 *
 * `rls: false` in one of those schemas is OKM1931. A table that already
 * enables row security keeps its `force` flag. Extension tables are skipped.
 *
 * @param objects - Catalog being built
 * @param schemas - Schema names the preset covers
 */
function stampRls(objects: CatalogObject[], schemas: readonly string[]): void {
  const covered = new Set(schemas);
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    if (object === undefined || object.kind !== "table") continue;
    if (object.provenance.origin === "extension") continue;
    if (object.identity.namespace.form !== "static") continue;
    if (!covered.has(object.identity.namespace.name)) continue;
    const security = object.definition.rowSecurity;
    if (security?.enable === false) {
      throw new OkmError(
        "OKM1931",
        `Table ${object.identity.name} sets rls: false, and enableRls covers schema ${object.identity.namespace.name}.`,
        {
          fix: {
            summary: "Remove rls: false, or take the table's schema out of enableRls.",
          },
        },
      );
    }
    if (security?.enable === true) continue;
    objects[index] = catalogTable({
      namespace: object.identity.namespace,
      name: object.identity.name,
      owner: object.owner,
      provenance: object.provenance,
      dependencies: object.dependencies.map((edge) => edge.target),
      ...(object.comment !== undefined ? { comment: object.comment } : {}),
      ...(object.definition.partition !== undefined
        ? { partition: object.definition.partition }
        : {}),
      rowSecurity: { enable: true, force: security?.force === true },
    });
  }
}

function requireEventFunction(
  triggerName: string,
  calls: EventTriggerOptions["calls"],
  objects: readonly CatalogObject[],
): FunctionObject {
  const found = objects.find(
    (object): object is FunctionObject =>
      object.kind === "function" &&
      object.identity.name === calls.name &&
      object.identity.namespace.form === "static" &&
      object.identity.namespace.name === calls.schema &&
      object.identity.argTypes.length === calls.argTypes.length,
  );
  if (found === undefined) {
    throw new OkmError(
      "OKM1020",
      `Event trigger ${triggerName} calls ${calls.name}, which is not in the catalog.`,
      { fix: { summary: "List the function in schema({ functions }) before the trigger." } },
    );
  }
  if (found.definition.language !== "plpgsql") {
    throw new OkmError(
      "OKM1931",
      `Event trigger ${triggerName} calls ${calls.name}, which is ${found.definition.language}. An event trigger function must be plpgsql.`,
      { fix: { summary: 'Set language: "plpgsql" on the function.' } },
    );
  }
  if (found.definition.arguments.some((item) => item.mode !== "out")) {
    throw new OkmError(
      "OKM1931",
      `Event trigger ${triggerName} calls ${calls.name}, which has arguments (42P13).`,
      { fix: { summary: "Remove the arguments. An event trigger function takes none." } },
    );
  }
  if (found.definition.returns !== "event_trigger") {
    throw new OkmError(
      "OKM1931",
      `Event trigger ${triggerName} calls ${calls.name}, which returns ${found.definition.returns || "nothing"} (42P17).`,
      { fix: { summary: 'Set returns: eventTriggerType, or returns: "event_trigger".' } },
    );
  }
  return found;
}

function asObjects(built: unknown): CatalogObject[] {
  if (!Array.isArray(built)) {
    throw new OkmError("OKM1020", "schema({ triggers }) must be a list.", {
      fix: { summary: "Pass an array to schema({ triggers })." },
    });
  }
  return built as CatalogObject[];
}
