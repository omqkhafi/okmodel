/**
 * Safety spike. Nothing here is part of the published `okmodel` package.
 */

export { SafetyError, type SafetyCode, type Violation, sortViolations } from "./errors.js";
export {
  FILTER_OPERATOR_NAMES,
  type FilterSpec,
  type ParsedFilters,
  defineFilters,
  parseFilters,
} from "./filters.js";
export { compose } from "./compose.js";
export {
  POSTGRES_IDENTIFIER_MAX_BYTES,
  RESERVED_WORDS,
  assertIdentifier,
  assertKnownField,
  assertUnquotedIdentifier,
  isReservedWord,
  isSingleQuotedIdentifier,
  quoteIdentifier,
  quoteQualified,
  unquoteIdentifier,
  utf8ByteLength,
} from "./identifier.js";
export {
  type ArchiveMode,
  type BoolExpr,
  type Catalog,
  type Contribution,
  type LogicalQuery,
  type QueryDraft,
  type TableMeta,
  andExpr,
  defineTable,
  orExpr,
  predExpr,
  tableByName,
  usableReason,
} from "./model.js";
export {
  OPERATOR_NAMES,
  type FilterValue,
  type OperatorName,
  type ReadFilter,
  type TaggedOperator,
  type Where,
  between,
  contains,
  every,
  gt,
  gte,
  has,
  inList,
  isTaggedOperator,
  lt,
  lte,
  none,
  not,
  or,
  readFilterInput,
  startsWith,
} from "./operators.js";
export { type PhysicalPlan, plan } from "./plan.js";
export {
  type VerifiedQuery,
  collectViolations,
  implies,
  isVerified,
  verify,
  walkPredicates,
} from "./verify.js";
