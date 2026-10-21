/**
 * Builds the `okm.cli/1` error object from an {@link OkmError} and the registry.
 *
 * Unknown codes (a kind name such as `driver`) keep the six X1 fields.
 * A registered code adds `docs`, and the alternatives and hatches the
 * registry recorded. Location and `fixEdit` come only from the producer.
 */

import { OkmError, type ErrorCategory, type ErrorKind } from "../../contracts/error.js";
import { sessionFailure } from "../migrate/lost.js";
import type { CliNoticeLevel, CliNoticeSeverity, CliWarningBody } from "../cli/outcome.js";
import { errorDoc, type ErrorDoc } from "./registry.js";
import {
  errorDocsPath,
  readCliDetail,
  type CliErrorLocation,
  type CliEscapeHatch,
  type CliFixEdit,
  type CliSafeAlternative,
} from "./shape.js";

/** One error in `errors`. Key order is the contract order. */
export type CliErrorBody = {
  readonly code: string;
  readonly kind: ErrorKind;
  readonly category: ErrorCategory;
  readonly summary: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly location?: CliErrorLocation;
  readonly fixEdit?: CliFixEdit;
  readonly safeAlternatives?: readonly CliSafeAlternative[];
  readonly docs?: string;
  readonly escapeHatches?: readonly CliEscapeHatch[];
};

/**
 * Error object for `errors[]`.
 *
 * `summary` and `fix` are the thrown text. The registry fills `docs` and
 * the lists. A kind-only code stays at the six original fields.
 *
 * @param error - Failure from a command
 * @returns The object, keys in contract order
 */
export function errorBody(error: unknown): CliErrorBody {
  const mapped = sessionFailure(error) ?? OkmError.from(error);
  const doc = errorDoc(mapped.code);
  const detail = readCliDetail(mapped) ?? readCliDetail(error);
  const body: {
    code: string;
    kind: ErrorKind;
    category: ErrorCategory;
    summary: string;
    fix: string;
    retryable: boolean;
    location?: CliErrorLocation;
    fixEdit?: CliFixEdit;
    safeAlternatives?: readonly CliSafeAlternative[];
    docs?: string;
    escapeHatches?: readonly CliEscapeHatch[];
  } = {
    code: mapped.code,
    kind: mapped.kind,
    category: mapped.category,
    summary: mapped.message,
    fix: mapped.fix.summary,
    retryable: mapped.retryable,
  };
  if (detail?.location !== undefined) body.location = detail.location;
  if (detail?.fixEdit !== undefined) body.fixEdit = detail.fixEdit;
  if (doc !== undefined) {
    if (doc.safeAlternatives !== undefined && doc.safeAlternatives.length > 0) {
      body.safeAlternatives = doc.safeAlternatives;
    }
    body.docs = errorDocsPath(doc.code);
    if (doc.escapeHatches !== undefined && doc.escapeHatches.length > 0) {
      body.escapeHatches = doc.escapeHatches;
    }
  }
  return body;
}

/**
 * Fills a warning from the registry when it has a code.
 *
 * Existing fields stay first. `level` is `hint` for OKM3xxx and `warn`
 * for every other code. Severity defaults to `low` for a hint and `medium`
 * for a warning when the caller did not set one.
 *
 * @param input - Notice a command already built
 * @returns The object, keys in contract order
 */
export function warningBody(input: CliWarningBody): CliWarningBody {
  const code = input.code;
  const doc = code === undefined ? undefined : errorDoc(code);
  const level = input.level ?? levelFor(code);
  const severity =
    input.severity ?? (level === "hint" ? "low" : level === "warn" ? "medium" : undefined);
  const body: {
    code?: string;
    summary: string;
    place?: string;
    fix?: string;
    location?: CliErrorLocation;
    fixEdit?: CliFixEdit;
    safeAlternatives?: readonly CliSafeAlternative[];
    docs?: string;
    escapeHatches?: readonly CliEscapeHatch[];
    level?: CliNoticeLevel;
    severity?: CliNoticeSeverity;
  } = { summary: input.summary };
  if (code !== undefined) body.code = code;
  if (input.place !== undefined) body.place = input.place;
  if (input.fix !== undefined) body.fix = input.fix;
  if (input.location !== undefined) body.location = input.location;
  if (input.fixEdit !== undefined) body.fixEdit = input.fixEdit;
  if (doc !== undefined) fillDoc(body, doc);
  if (level !== undefined) body.level = level;
  if (severity !== undefined) body.severity = severity;
  return body;
}

function fillDoc(
  body: {
    safeAlternatives?: readonly CliSafeAlternative[];
    docs?: string;
    escapeHatches?: readonly CliEscapeHatch[];
  },
  doc: ErrorDoc,
): void {
  if (doc.safeAlternatives !== undefined && doc.safeAlternatives.length > 0) {
    body.safeAlternatives = doc.safeAlternatives;
  }
  body.docs = errorDocsPath(doc.code);
  if (doc.escapeHatches !== undefined && doc.escapeHatches.length > 0) {
    body.escapeHatches = doc.escapeHatches;
  }
}

function levelFor(code: string | undefined): CliNoticeLevel | undefined {
  if (code === undefined) return undefined;
  if (code.startsWith("OKM3")) return "hint";
  return "warn";
}
