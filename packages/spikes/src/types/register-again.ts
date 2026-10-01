/**
 * Second augmentation of the same schema type.
 *
 * Identical property types merge. A different schema type is a conflict and
 * lives in an excluded project, because it would fail this typecheck.
 */

import { appSchema } from "./register-schema.js";

declare module "@okmodel/spikes/types" {
  interface Register {
    readonly schema: typeof appSchema;
  }
}
