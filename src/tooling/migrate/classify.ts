/**
 * Expand, contract, or raw SQL.
 *
 * The table lives in the dialect layer. This module re-exports it so
 * existing tooling imports keep their path.
 */

export {
  STEP_CLASS,
  STEP_KINDS,
  classOf,
  isStepKind,
  strictestClass,
  type MigrationClass,
  type StepKind,
} from "../../dialects/step-class.js";
