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
import { untrustedText, type UntrustedText } from "../untrusted.js";
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
  readonly detail?: UntrustedText;
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
  const attached = readCliDetail(mapped) ?? readCliDetail(error);
  const leaked = attached?.detail ?? databaseDetail(mapped);
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
    detail?: UntrustedText;
  } = {
    code: mapped.code,
    kind: mapped.kind,
    category: mapped.category,
    summary:
      leaked === undefined
        ? mapped.message
        : (doc?.summary ?? `A database error was returned (${mapped.kind}).`),
    fix: fixOf(mapped, doc, leaked !== undefined),
    retryable: mapped.retryable,
  };
  if (attached?.location !== undefined) body.location = attached.location;
  if (attached?.fixEdit !== undefined) body.fixEdit = attached.fixEdit;
  if (doc !== undefined) {
    if (doc.safeAlternatives !== undefined && doc.safeAlternatives.length > 0) {
      body.safeAlternatives = doc.safeAlternatives;
    }
    body.docs = errorDocsPath(doc.code);
    if (doc.escapeHatches !== undefined && doc.escapeHatches.length > 0) {
      body.escapeHatches = doc.escapeHatches;
    }
  }
  if (leaked !== undefined) body.detail = leaked;
  return body;
}

function databaseDetail(mapped: OkmError): UntrustedText | undefined {
  const fromDriver =
    mapped.code === "driver" ||
    mapped.code === "unavailable" ||
    mapped.sqlstate !== undefined ||
    mapped.constraint !== undefined;
  if (!fromDriver) return undefined;
  const origin =
    mapped.constraint !== undefined && mapped.message === mapped.constraint
      ? "constraint.name"
      : "db.error";
  return untrustedText(mapped.message, origin);
}

function fixOf(mapped: OkmError, doc: ErrorDoc | undefined, leaked: boolean): string {
  const thrown = mapped.fix.summary;
  if (!leaked) return thrown;
  const bits = [mapped.message, mapped.constraint, mapped.table].filter(
    (bit): bit is string => bit !== undefined && bit.length > 0,
  );
  if (bits.some((bit) => thrown.includes(bit))) return doc?.fix ?? "See the detail.";
  return thrown;
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
