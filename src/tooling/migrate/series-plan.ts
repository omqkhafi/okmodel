/**
 * Series planning for `plan.ts`.
 *
 * The planner file must not name `dialects/pg`. This module is the one
 * import of the sequence engine.
 */

export {
  alterSequence,
  assertSeries,
  counterSteps,
  foldSeries,
  ownSequenceStep,
  type SeriesWarning,
} from "../../dialects/pg/seq/engine.js";
