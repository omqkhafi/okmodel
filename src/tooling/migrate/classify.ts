/**
 * Expand, contract, or raw SQL.
 *
 * The table lives in the dialect layer. This module re-exports it so
 * existing tooling imports keep their path.
 */

export {
  OPERATION_CLASS,
  STEP_CLASS,
  STEP_KINDS,
  classOf,
  isStepKind,
  operationClassOf,
  strictestClass,
  strictestOperation,
  type MigrationClass,
  type OperationClass,
  type StepKind,
} from "../../dialects/step-class.js";
