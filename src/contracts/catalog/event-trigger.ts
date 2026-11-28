/**
 * Event-trigger catalog objects.
 *
 * The factory stores the record. It does not plan SQL. `trigger({ event })`
 * stays on `okmodel/fn`, and the compiler that fills it loads from `okmodel/event`.
 */

import { catalogError } from "../error.js";
import { assertIdentifier } from "./identifier.js";
import { assertNamespace, staticNamespace } from "./identity.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  EventTriggerDefinition,
  EventTriggerEnabled,
  EventTriggerEvent,
  EventTriggerObject,
  Namespace,
  ObjectIdentity,
  Owner,
  Provenance,
} from "./types.js";

/** Input for {@link eventTriggerObject}. */
export type EventTriggerInput = {
  readonly name: string;
  readonly event: EventTriggerEvent;
  readonly tags?: readonly string[];
  readonly enabled?: EventTriggerEnabled;
  readonly calls: {
    readonly namespace: Namespace;
    readonly name: string;
    readonly argTypes: readonly string[];
  };
  readonly ownedBy?: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
  /** Absent means the comment is not managed. */
  readonly comment?: string;
};

const EVENTS = new Set<EventTriggerEvent>([
  "ddl_command_start",
  "ddl_command_end",
  "sql_drop",
  "table_rewrite",
]);
const ENABLED = new Set<EventTriggerEnabled>(["origin", "disabled", "replica", "always"]);

/**
 * Builds an event-trigger record.
 *
 * The name is database-wide. Tags are stored uppercase, in the order given.
 * `enabled` defaults to `origin`, which is PostgreSQL's `ENABLE`.
 *
 * @param input - Event, tags, and the function it calls
 * @returns The catalog object
 */
export function eventTriggerObject(input: EventTriggerInput): EventTriggerObject {
  assertIdentifier(input.name, "event trigger");
  assertProvenance(input.provenance);
  if (!EVENTS.has(input.event)) {
    catalogError("OKM1020", `Event trigger ${input.name} event ${input.event} is not supported.`);
  }
  const enabled = input.enabled ?? "origin";
  if (!ENABLED.has(enabled)) {
    catalogError("OKM1020", `Event trigger ${input.name} enabled ${enabled} is not supported.`);
  }
  assertIdentifier(input.calls.name, "event trigger function");
  assertNamespace(input.calls.namespace);
  if (input.calls.argTypes.length > 0) {
    catalogError("OKM1020", `Event trigger ${input.name} calls a function with arguments.`);
  }
  const tags = input.tags === undefined ? undefined : input.tags.map((tag) => tag.toUpperCase());
  if (tags !== undefined) {
    for (const tag of tags) {
      if (tag.length === 0 || tag.includes("'")) {
        catalogError("OKM1020", `Event trigger ${input.name} has an empty command tag.`);
      }
    }
  }
  if (input.ownedBy !== undefined && input.ownedBy.length === 0) {
    catalogError("OKM1020", `Event trigger ${input.name} owner is empty.`);
  }
  const namespace = input.calls.namespace ?? staticNamespace("public");
  const definition: EventTriggerDefinition = {
    event: input.event,
    enabled,
    calls: {
      namespace,
      name: input.calls.name,
      argTypes: [],
    },
    ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
    ...(input.ownedBy !== undefined ? { ownedBy: input.ownedBy } : {}),
  };
  return {
    kind: "eventTrigger",
    identity: { kind: "eventTrigger", name: input.name },
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(
      input.dependencies ?? [
        {
          kind: "function",
          namespace,
          name: input.calls.name,
          argTypes: [],
        },
      ],
    ),
    provenance: input.provenance,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };
}
