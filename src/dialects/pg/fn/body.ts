/**
 * Compiles a routine body.
 *
 * A string is stored as written. A one-argument callback receives a handle
 * and is not called until `schema()` builds the catalog. A two-argument
 * callback is a procedure: its statements become `BEGIN ATOMIC`, and every
 * parameter is qualified.
 */

import { OkmError } from "../../../contracts/error.js";
import type { Names } from "../casing.js";
import { quoteIdent } from "../ddl.js";
import type { SqlText } from "../table.js";
import { compileProcedureStatement, type ProcedureStatement } from "../view/compile.js";
import { procArg, procArgOf } from "./arg.js";
import { routineControl } from "./control.js";

/** A body after it has been compiled. */
export type CompiledBody = {
  readonly sql: string;
  /** `BEGIN ATOMIC`. Postgres records dependencies for this form. */
  readonly atomic: boolean;
  /** Tables the callback touched. A string body leaves this empty. */
  readonly dependsOn: readonly object[];
  readonly commits: boolean;
  readonly commitInException: boolean;
};

/**
 * Compiles a body the first time the catalog is built.
 *
 * @param name - Routine name
 * @param kind - Function or procedure
 * @param body - String, `sql` text, or a callback
 * @param tables - Tables the schema declared
 * @param names - Schema casing
 * @param args - Declared argument names
 * @returns The SQL and the tables the callback used
 */
export function compileBody(
  name: string,
  kind: "function" | "procedure",
  body: unknown,
  tables: readonly object[],
  names: Names,
  args: readonly string[],
): CompiledBody {
  if (typeof body === "string" || isSqlText(body)) {
    const sql = typeof body === "string" ? body : body.text;
    const control = routineControl(sql);
    return {
      sql,
      atomic: /^\s*begin\s+atomic\b/i.test(sql),
      dependsOn: [],
      commits: control.commits,
      commitInException: control.commitInException,
    };
  }
  if (typeof body !== "function") {
    throw new OkmError("OKM1020", `${label(kind)} ${name} needs a body.`, {
      fix: { summary: "Pass sql text, or a callback that returns sql." },
    });
  }
  if (body.length >= 2) {
    if (kind !== "procedure") {
      throw new OkmError("OKM1020", `Function ${name} cannot use a statement body.`, {
        fix: { summary: 'Statement bodies are kind: "procedure". A function takes sql text.' },
      });
    }
    return compileStatements(name, body as StatementBody, tables, names, args);
  }
  return compileHandle(name, body as HandleBody, tables, names, args);
}

type StatementBody = (args: unknown, query: unknown) => readonly ProcedureStatement[];
type HandleBody = (handle: BodyHandle) => SqlText | string;

type BodyHandle = {
  /**
   * Records a table and interpolates its SQL name.
   *
   * @param strings - Literal parts
   * @param values - Tables, columns, arguments, or text
   * @returns The SQL the body stores
   */
  sql(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlText;
  /**
   * One declared argument, qualified in the printed SQL.
   *
   * @param name - Argument name
   * @returns The marker the printer qualifies
   */
  arg(name: string): unknown;
  /**
   * Records a table the body uses when the SQL does not interpolate it.
   *
   * @param table - A table from `schema({ tables })`
   */
  reads(table: object): void;
};

function compileStatements(
  name: string,
  body: StatementBody,
  tables: readonly object[],
  names: Names,
  args: readonly string[],
): CompiledBody {
  const known = new Set(args);
  const statements = body(argumentProxy(name, known), queryProxy(name, tables));
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new OkmError("OKM1020", `Procedure ${name} needs at least one statement.`, {
      fix: { summary: "Return an array of statements. The last one feeds OUT parameters." },
    });
  }
  const reads: object[] = [];
  const lines = statements.map((statement) => {
    if (statement !== null && typeof statement === "object" && "source" in statement) {
      const source = (statement as { readonly source?: object }).source;
      if (source !== undefined && !reads.includes(source)) reads.push(source);
    }
    return compileProcedureStatement(name, statement, tables, names);
  });
  const sql = `begin atomic\n${lines.map((line) => `  ${line};`).join("\n")}\nend`;
  return { sql, atomic: true, dependsOn: reads, commits: false, commitInException: false };
}

function compileHandle(
  name: string,
  body: HandleBody,
  tables: readonly object[],
  names: Names,
  args: readonly string[],
): CompiledBody {
  const reads: object[] = [];
  const known = new Set(args);
  const handle: BodyHandle = {
    sql(strings, ...values) {
      let text = strings[0] ?? "";
      for (let index = 0; index < values.length; index += 1) {
        text += interpolate(name, values[index], tables, names, known, reads);
        text += strings[index + 1] ?? "";
      }
      return { text };
    },
    arg(argument) {
      if (!known.has(argument)) {
        throw new OkmError("OKM1020", `Procedure ${name} has no argument ${argument}.`, {
          fix: { summary: "Name an argument from the declaration." },
        });
      }
      return procArg(name, argument);
    },
    reads(table) {
      if (!tables.includes(table)) {
        throw new OkmError(
          "OKM1020",
          `${label("procedure")} ${name} reads a table that is not in tables.`,
          {
            fix: { summary: "Pass a table from schema({ tables })." },
          },
        );
      }
      if (!reads.includes(table)) reads.push(table);
    },
  };
  const produced = body(handle);
  const sql = typeof produced === "string" ? produced : produced.text;
  const control = routineControl(sql);
  return {
    sql,
    atomic: /^\s*begin\s+atomic\b/i.test(sql),
    dependsOn: reads,
    commits: control.commits,
    commitInException: control.commitInException,
  };
}

function interpolate(
  name: string,
  value: unknown,
  tables: readonly object[],
  names: Names,
  args: ReadonlySet<string>,
  reads: object[],
): string {
  const argument = procArgOf(value);
  if (argument !== undefined) {
    if (!args.has(argument.name)) {
      throw new OkmError("OKM1020", `Procedure ${name} has no argument ${argument.name}.`, {
        fix: { summary: "Name an argument from the declaration." },
      });
    }
    return `${quoteIdent(argument.routine)}.${quoteIdent(argument.name)}`;
  }
  if (isTable(value)) {
    if (!tables.includes(value)) {
      throw new OkmError("OKM1020", `${name} interpolates a table that is not in tables.`, {
        fix: { summary: "Pass a table from schema({ tables })." },
      });
    }
    if (!reads.includes(value)) reads.push(value);
    return quoteIdent(names.table(value as never));
  }
  if (isColumn(value)) return quoteIdent(value.name);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return "null";
  if (isSqlText(value)) return value.text;
  throw new OkmError("OKM1020", `${name} cannot interpolate that value.`, {
    fix: { summary: "Interpolate a table, a column, an argument, or text." },
  });
}

function argumentProxy(routine: string, args: ReadonlySet<string>): unknown {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (!args.has(key)) {
          throw new OkmError("OKM1020", `Procedure ${routine} has no argument ${key}.`, {
            fix: { summary: "Name an argument from the declaration." },
          });
        }
        return procArg(routine, key);
      },
    },
  );
}

function queryProxy(name: string, tables: readonly object[]): unknown {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "sql") {
          return (input: string | SqlText) => ({
            op: "sql" as const,
            query: typeof input === "string" ? input : input.text,
          });
        }
        if (typeof key !== "string") {
          throw new OkmError("OKM1120", `Procedure ${name} cannot read that key.`, {
            fix: { summary: "Use a table name from schema({ tables })." },
          });
        }
        const source = tables.find((item) => isNamed(item) && item.name === key);
        if (source === undefined) {
          throw new OkmError("OKM1120", `Procedure ${name} reads ${key}, which is not in tables.`, {
            fix: { summary: "Add the table to schema({ tables })." },
          });
        }
        return {
          find: (options?: Readonly<Record<string, unknown>>) => ({
            op: "find" as const,
            source,
            options: options ?? {},
          }),
          aggregate: (options?: Readonly<Record<string, unknown>>) => ({
            op: "aggregate" as const,
            source,
            options: options ?? {},
          }),
          insert: (options: { readonly values: Readonly<Record<string, unknown>> }) => ({
            op: "insert" as const,
            source,
            options,
          }),
          update: (options: {
            readonly set: Readonly<Record<string, unknown>>;
            readonly where?: unknown;
          }) => ({ op: "update" as const, source, options }),
          delete: (options?: { readonly where?: unknown }) => ({
            op: "delete" as const,
            source,
            options: options ?? {},
          }),
        };
      },
    },
  );
}

function isSqlText(value: unknown): value is SqlText {
  return (
    typeof value === "object" && value !== null && "text" in value && typeof value.text === "string"
  );
}

function isNamed(value: object): value is { readonly name: string } {
  return "name" in value && typeof value.name === "string";
}

function isTable(value: unknown): value is { readonly name: string; readonly columns: object } {
  return (
    typeof value === "object" &&
    value !== null &&
    "columns" in value &&
    typeof value.columns === "object" &&
    value.columns !== null &&
    "name" in value &&
    typeof value.name === "string"
  );
}

function isColumn(value: unknown): value is { readonly name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    !("columns" in value) &&
    !("text" in value)
  );
}

function label(kind: "function" | "procedure"): string {
  return kind === "procedure" ? "Procedure" : "Function";
}
