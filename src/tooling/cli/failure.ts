/**
 * Text `okm` prints for a failure, in the voice of D330.
 *
 * The shape is fixed: `error <code>: <what happened>`, any lines the message
 * carries (SQL, findings), a fix line, `Details: okm help <code>` when the code
 * has a page, then `config:` and the stack. The words of `--json` never pass
 * through here: this module rewrites how a person reads the same facts.
 */

import { OkmError } from "../../contracts/error.js";
import { nearestName } from "../../contracts/nearest.js";
import { ERROR_DOCS, errorDoc } from "../errors/registry.js";
import { knownFix } from "../errors/known-fix.js";
import { sessionFailure } from "../migrate/lost.js";
import { readConfigPath } from "./outcome.js";
import { wrap } from "./output.js";

/** What a failure says: one prose line, raw lines after it, and the next step. */
type Said = {
  readonly lead: string;
  readonly rest: string;
  readonly fix: string;
};

const DRIFT_HEAD = "The database differs from the schema.";
const DRIFT_FIX = "Change the schema or the database so okm check reports no difference.";
/** The OKM1510 message `okm generate` throws when a person answers no to a drop. */
const DECLINED = "The migration drops data and was not confirmed. Nothing was written.";
const UNREACHABLE = /\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|CONNECT_TIMEOUT)\b/;
const FINDING = /^(error|warning) OKM\d{4} [^:]+: /;

/**
 * Text `okm` writes to stderr for a failure.
 *
 * @param error - Failure from a command
 * @param verbose - When true, append the stack
 * @param columns - Where prose wraps. The default leaves it unwrapped
 * @returns Plain text, including the trailing newline. `writeErr` colors it
 */
export function failureText(
  error: unknown,
  verbose = false,
  columns = Number.POSITIVE_INFINITY,
): string {
  const mapped = sessionFailure(error) ?? OkmError.from(error);
  const raw = typeof error === "object" && error !== null ? error : undefined;
  const configPath = raw === undefined ? undefined : readConfigPath(raw);
  const first = (lead: string): string => wrap(`error ${mapped.code}: ${lead}`, columns);
  let text: string;
  if (unexpected(error, mapped)) {
    const line = mapped.message.split("\n")[0] ?? mapped.message;
    const hint = verbose ? "" : " (I did not expect this. OKM_DEBUG=1 shows where.)";
    text = `${first(`${line}${hint}`)}\n`;
  } else {
    const said = voice(mapped);
    text = `${first(said.lead)}${said.rest}\n`;
    text += `${wrap(said.fix, columns)}\n`;
    if (errorDoc(mapped.code) !== undefined) text += `Details: okm help ${mapped.code}\n`;
  }
  if (configPath !== undefined) text += `config: ${configPath}\n`;
  if (verbose && error instanceof Error && error.stack !== undefined) text += `${error.stack}\n`;
  return text;
}

/** A thrown value that is neither an `OkmError` nor a driver error: a bug, not a refusal. */
function unexpected(error: unknown, mapped: OkmError): boolean {
  return (
    mapped.code === "driver" &&
    mapped.kind === "driver" &&
    error instanceof Error &&
    !(error instanceof OkmError) &&
    error.name !== "DriverError" &&
    mapped.fix.summary === "Read the summary and correct the call."
  );
}

function voice(mapped: OkmError): Said {
  const message = mapped.message;
  const newline = message.indexOf("\n");
  const lead = newline === -1 ? message : message.slice(0, newline);
  const rest = newline === -1 ? "" : message.slice(newline);
  const fix = knownFix(mapped) ?? mapped.fix.summary;
  const plain: Said = { lead, rest, fix };

  if (mapped.code === "OKM1520" && lead === DRIFT_HEAD && fix === DRIFT_FIX) {
    const count = rest.split("\n").filter((line) => /^[a-z]/i.test(line)).length;
    if (count === 0) return plain;
    const noun = count === 1 ? "difference" : "differences";
    return {
      lead: `I found ${String(count)} ${noun} between the schema and the database.`,
      rest,
      fix: `I changed nothing. ${fix}`,
    };
  }
  if (mapped.code === "OKM1530") return renameVoice(plain);
  if (mapped.code === "OKM1510") return refusalVoice(plain, message);
  const missing = /^Missing (.+)\.$/.exec(lead);
  if (mapped.code === "OKM1895" && missing !== null) {
    return { lead: `I could not find ${missing[1] ?? ""}.`, rest, fix: `I did nothing. ${fix}` };
  }
  const unknown = /^Unknown code (.+)\.$/.exec(lead);
  if (mapped.code === "invalid" && unknown !== null) return unknownCodeVoice(unknown[1] ?? "");
  if (mapped.code === "unavailable" && UNREACHABLE.test(message)) {
    return {
      lead,
      rest,
      fix: "I could not reach the target, so I changed nothing. Check the host and port in the database URL, then run the command again.",
    };
  }
  return plain;
}

function renameVoice(said: Said): Said {
  const found = /^Drop (.+?) and add (.+?) could be a rename( caused by casing)?\./.exec(said.lead);
  if (found === null) return said;
  const lead = `I found a drop of ${found[1] ?? ""} and an add of ${found[2] ?? ""}, which could be a rename${found[3] === undefined ? "" : " caused by casing"}.`;
  const table = said.fix.startsWith("Add renamedFrom:");
  const own = said.fix.endsWith(".") ? said.fix.slice(0, -1) : said.fix;
  const tail =
    found[3] === undefined ? `, or drop the ${table ? "table" : "column"} on purpose.` : ".";
  return { lead, rest: said.rest, fix: `I stopped before changing anything. ${own}${tail}` };
}

function refusalVoice(said: Said, message: string): Said {
  if (message === DECLINED) {
    return {
      lead: "I did not write this migration. It drops data and the drop was not confirmed.",
      rest: "",
      fix: said.fix,
    };
  }
  const lines = message.split("\n").filter((line) => line.length > 0);
  if (!lines.every((line) => FINDING.test(line))) return said;
  const errors = lines.filter((line) => line.startsWith("error ")).length;
  const rest = lines.map((line) => `\n${line}`);
  const noun = errors === 1 ? "error" : "errors";
  return {
    lead: `I found ${String(errors)} ${noun} in this migration, so okm migrate apply will refuse it.`,
    rest: rest.join(""),
    fix: said.fix,
  };
}

function unknownCodeVoice(code: string): Said {
  const codes = ERROR_DOCS.map((doc) => doc.code);
  const hint = nearestName(code.toUpperCase(), codes) ?? nearestByNumber(code, codes);
  const fix =
    hint === undefined
      ? "Run okm help to see the commands, or okm doctor to read a target report."
      : `Did you mean ${hint}? Run okm help ${hint} to read it.`;
  return { lead: `I do not know the code ${code}.`, rest: "", fix };
}

function nearestByNumber(code: string, codes: readonly string[]): string | undefined {
  const want = Number(/^OKM(\d+)$/i.exec(code)?.[1]);
  if (!Number.isFinite(want)) return undefined;
  let best: string | undefined;
  let gap = Number.POSITIVE_INFINITY;
  for (const item of codes) {
    const distance = Math.abs(Number(item.slice(3)) - want);
    if (distance < gap) {
      gap = distance;
      best = item;
    }
  }
  return best;
}
