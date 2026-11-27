/**
 * `okm call <routine>`.
 *
 * Types and defaults come from the declaration. JSON has no connection
 * strings. `--rollback` runs the call in a transaction and rolls it back.
 * A procedure with `commits: true` refuses that flag before any SQL is sent.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { OkmError } from "../../contracts/error.js";
import { registeredRoutines, type ProcedureSpec } from "../../dialects/pg/fn/index.js";
import { connect } from "../../runtime/pg/postgresjs.js";
import { driverUrl } from "./driver-url.js";
import { loadConfig, loadSchema } from "./project.js";
import { assertTargetPolicy, selectTarget } from "./policy.js";
import type { ParsedCli } from "../cli/parse.js";
import type { ProjectContext } from "./paths.js";

const PROCEDURE = Symbol.for("okm.procedure");

/**
 * Calls one procedure and returns JSON.
 *
 * @param project - Project directory and config path
 * @param parsed - The parsed invocation
 * @param cwd - Working directory
 * @param human - Writes the JSON line when the caller is not in JSON mode
 * @returns The envelope payload
 */
export async function callCommand(
  project: ProjectContext,
  parsed: ParsedCli,
  cwd: string,
  human: (text: string) => void,
): Promise<{
  readonly text: string;
  readonly data: unknown;
  readonly warnings: readonly never[];
  readonly outFile: null;
}> {
  const config = await loadConfig(project);
  const target = selectTarget(config, parsed.target);
  assertTargetPolicy(target, parsed.rollback ? "status" : "seed", parsed.allowProtected);
  const name = parsed.operands[0] ?? "";
  const schema = await loadSchema(cwd, config.schema);
  const found = registeredRoutines().filter(
    (item) => item.routine === "procedure" && item.name === name,
  );
  const routine = found[0];
  if (routine === undefined) {
    throw new OkmError("OKM1120", `Procedure ${name} is not declared.`, {
      fix: { summary: "Pass the name fn() declared, and export that schema." },
    });
  }
  if (found.length > 1) {
    throw new OkmError("OKM1023", `Procedure ${name} has more than one signature.`, {
      fix: { summary: "okm call needs one procedure of that name." },
    });
  }
  if (parsed.rollback && routine.spec.commits) {
    throw new OkmError("OKM1551", `Procedure ${name} commits, so okm call --rollback refuses it.`, {
      fix: { summary: "Drop --rollback. A committing procedure cannot run in a transaction." },
    });
  }
  const args = coerce(name, routine.spec, parsed.args);
  const pool = open({ url: driverUrl(target.url), max: 1 });
  try {
    const db = connect(pool, { schema });
    const result = parsed.rollback
      ? await rolledBack(db, routine.spec, args)
      : await invoke(db, routine.spec, args);
    const data = {
      routine: name,
      rolledBack: parsed.rollback,
      result: result === undefined ? null : result,
    };
    const text = `${JSON.stringify(data)}\n`;
    human(text);
    return { text, data, warnings: [], outFile: null };
  } finally {
    await pool.close();
  }
}

async function rolledBack(
  db: object,
  spec: ProcedureSpec,
  args: Record<string, unknown>,
): Promise<unknown> {
  const marker = new Error("okm call rollback");
  let result: unknown;
  try {
    await (db as { tx(body: (tx: object) => Promise<unknown>): Promise<unknown> }).tx(
      async (tx) => {
        result = await invoke(tx, spec, args);
        throw marker;
      },
    );
  } catch (error) {
    if (error !== marker) throw error;
  }
  return result;
}

async function invoke(
  db: object,
  spec: ProcedureSpec,
  args: Record<string, unknown>,
): Promise<unknown> {
  const slot = (db as Record<symbol, unknown>)[PROCEDURE];
  if (typeof slot !== "function") {
    throw new OkmError("OKM1120", `Procedure ${spec.label} needs a connected client.`, {
      fix: { summary: "Connect with okmodel before calling the procedure." },
    });
  }
  return (slot as (spec: ProcedureSpec, args: object, options: undefined) => Promise<unknown>)(
    spec,
    args,
    undefined,
  );
}

function coerce(
  name: string,
  spec: ProcedureSpec,
  flags: readonly string[],
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq <= 0) {
      throw new OkmError("invalid", "--arg needs name=value.", {
        fix: { summary: "Pass --arg id=1." },
      });
    }
    const key = flag.slice(0, eq);
    const raw = flag.slice(eq + 1);
    const argument = spec.arguments.find((item) => item.name === key);
    if (argument === undefined || argument.mode === "out") {
      throw new OkmError("OKM1120", `Procedure ${name} has no IN argument ${key}.`, {
        fix: { summary: "Pass an IN or INOUT argument from the declaration." },
      });
    }
    args[key] = coerceValue(argument.sqlType, raw);
  }
  return args;
}

function coerceValue(sqlType: string, value: string): unknown {
  if (value === "null") return null;
  if (
    sqlType === "integer" ||
    sqlType === "smallint" ||
    sqlType === "int2" ||
    sqlType === "int4" ||
    sqlType === "real" ||
    sqlType === "double precision"
  ) {
    return Number(value);
  }
  if (sqlType === "boolean" || sqlType === "bool") return value === "true";
  return value;
}
