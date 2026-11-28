/**
 * Event triggers and the four presets.
 *
 * Import this module before `schema()` when a trigger sets `event` or a
 * preset is in `schema({ triggers })`. The featureless app does not import it.
 *
 * @example
 * ```ts
 * import { fn, trigger, eventTriggerType } from "okmodel/fn";
 * import { auditDdl, enableRls, guardDdl, notifyDdl } from "okmodel/event";
 * ```
 */

import { installEventCompiler } from "./slot.js";
import { eventCompiler } from "./compile.js";

installEventCompiler(eventCompiler);

export { auditDdl, enableRls, guardDdl, notifyDdl } from "./presets.js";
export type {
  AuditDdlOptions,
  EnableRlsOptions,
  GuardBlock,
  GuardDdlOptions,
  NotifyDdlOptions,
} from "./presets.js";
export type { EventCommandTag } from "./tags.js";
export { COMMAND_TAGS, resolveRoleTokens } from "./tags.js";
