/**
 * The `okm.cli/1` envelope.
 *
 * Key order is fixed. `target` is omitted when the command did not select a
 * database. `ok` is true only when `exit` is 0.
 */

import { sha256 } from "../../contracts/sha256.js";
import { OkmError, type ErrorCategory, type ErrorKind } from "../../contracts/error.js";
import { sessionFailure } from "../migrate/lost.js";
import type { CliOutFile, CliTargetBody, CliWarningBody, ExitCode } from "./outcome.js";

/** Schema name frozen for this contract. */
export const CLI_SCHEMA = "okm.cli/1";

/** One error in `errors`. Further fields may be added later. */
export type CliErrorBody = {
  readonly code: string;
  readonly kind: ErrorKind;
  readonly category: ErrorCategory;
  readonly summary: string;
  /** The fix text `okm` already prints (`OkmError.fix.summary`). */
  readonly fix: string;
  readonly retryable: boolean;
};

/** Selected database. `fingerprint` has no URL, host, or credential. */
export type CliTarget = CliTargetBody;

/** One warning in `warnings`. */
export type CliWarning = CliWarningBody;

/** Document written to stdout for `--json`. */
export type CliEnvelope = {
  readonly schema: typeof CLI_SCHEMA;
  readonly command: string | null;
  readonly okmVersion: string;
  readonly capabilities: readonly string[];
  readonly ok: boolean;
  readonly exit: ExitCode;
  readonly target?: CliTarget;
  readonly data: unknown;
  readonly errors: readonly CliErrorBody[];
  readonly warnings: readonly CliWarning[];
  readonly truncated: boolean;
  readonly outFile: CliOutFile | null;
};

/**
 * Fingerprint of a resolved target.
 *
 * `hostDb` is the SHA-256 of lower-cased `host:port/database`. `identity`
 * is null until a later contract fills it.
 *
 * @param target - Name, protection, and endpoint parts. The URL is not read
 * @returns The envelope `target` object
 */
export function targetFingerprint(target: {
  readonly name: string;
  readonly protected: boolean;
  readonly host: string;
  readonly port: string;
  readonly database: string;
}): CliTarget {
  const hostDb = sha256(`${target.host}:${target.port}/${target.database}`.toLowerCase());
  return {
    name: target.name,
    protected: target.protected,
    fingerprint: { hostDb, identity: null },
  };
}

/**
 * Error object for `errors[]`.
 *
 * `summary` is today's message. `fix` is the existing fix text.
 *
 * @param error - Failure from a command
 * @returns The object
 */
export function errorBody(error: unknown): CliErrorBody {
  const mapped = sessionFailure(error) ?? OkmError.from(error);
  return {
    code: mapped.code,
    kind: mapped.kind,
    category: mapped.category,
    summary: mapped.message,
    fix: mapped.fix.summary,
    retryable: mapped.retryable,
  };
}

/**
 * One stderr line for a JSON failure on a terminal.
 *
 * A pipe stays empty so `2>&1` remains one JSON document.
 *
 * @param error - Failure from a command
 * @param tty - `process.stderr.isTTY`
 * @returns The line, including the newline, or `""`
 */
export function terseStderr(error: unknown, tty: boolean): string {
  if (!tty) return "";
  const body = errorBody(error);
  const summary = body.summary.split("\n")[0] ?? body.summary;
  return `error ${body.code}: ${summary}\n`;
}

/**
 * Serialises an envelope. Keys stay in contract order. `target` is absent
 * when `target` is omitted.
 *
 * @param envelope - Document to write
 * @returns JSON text ending in a newline
 */
export function serializeEnvelope(envelope: CliEnvelope): string {
  const body: Record<string, unknown> = {
    schema: envelope.schema,
    command: envelope.command,
    okmVersion: envelope.okmVersion,
    capabilities: envelope.capabilities,
    ok: envelope.ok,
    exit: envelope.exit,
  };
  if (envelope.target !== undefined) body.target = envelope.target;
  body.data = envelope.data;
  body.errors = envelope.errors;
  body.warnings = envelope.warnings;
  body.truncated = envelope.truncated;
  body.outFile = envelope.outFile;
  return `${JSON.stringify(body)}\n`;
}

/**
 * Builds an envelope.
 *
 * @param fields - Command result
 * @returns The document
 */
export function envelope(fields: {
  readonly command: string | null;
  readonly okmVersion: string;
  readonly exit: ExitCode;
  readonly target?: CliTarget;
  readonly data: unknown;
  readonly errors?: readonly CliErrorBody[];
  readonly warnings?: readonly CliWarning[];
  readonly outFile?: CliOutFile | null;
}): CliEnvelope {
  const exit = fields.exit;
  return {
    schema: CLI_SCHEMA,
    command: fields.command,
    okmVersion: fields.okmVersion,
    capabilities: [],
    ok: exit === 0,
    exit,
    ...(fields.target === undefined ? {} : { target: fields.target }),
    data: fields.data,
    errors: fields.errors ?? [],
    warnings: fields.warnings ?? [],
    truncated: false,
    outFile: fields.outFile ?? null,
  };
}
