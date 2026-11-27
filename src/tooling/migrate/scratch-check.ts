/**
 * Runs SQL in a scratch database and returns Postgres's own verdict.
 *
 * Later steps use this for immutability and validity: whether an expression
 * can sit in an index or a generated column is the server's answer, not a
 * guess. The statements run in one transaction that always rolls back, so
 * nothing is kept. With no `url` the database is an in-memory PGlite, which
 * needs the optional `@electric-sql/pglite` package.
 */

import { OkmError } from "../../contracts/error.js";
import { driverUrl } from "./driver-url.js";

/** The server accepted every statement, or refused one. */
export type ScratchVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Five-character SQLSTATE, for example `42P17` or `42883`. */
      readonly sqlstate: string;
      /** The statement the server refused. */
      readonly statement: string;
      readonly error: OkmError;
    };

/** Where the scratch statements run. */
export type ScratchOptions = {
  /** Provisioned database to use instead of PGlite. Nothing is kept. */
  readonly url?: string;
};

/**
 * Runs `statements` in order inside one transaction and rolls it back.
 *
 * @param statements - One statement or several, each ending without `;`
 * @param options - `url` to use a provisioned database
 * @returns `ok`, or the first refusal with its SQLSTATE and an OKM1848 error
 */
export async function checkScratch(
  statements: string | readonly string[],
  options?: ScratchOptions,
): Promise<ScratchVerdict> {
  const list = typeof statements === "string" ? [statements] : statements;
  const run = options?.url === undefined ? await pglite() : await provisioned(options.url);
  try {
    return await run.run(list);
  } finally {
    await run.close();
  }
}

type Runner = {
  run(list: readonly string[]): Promise<ScratchVerdict>;
  close(): Promise<void>;
};

/** One in-memory database per process. Every run ends in a rollback, so it stays clean. */
let shared: Promise<import("@electric-sql/pglite").PGlite> | undefined;

/** Closes the in-memory database the checker opened, if any. */
export async function closeScratch(): Promise<void> {
  const open = shared;
  shared = undefined;
  if (open !== undefined) await (await open).close();
}

function openPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  shared ??= import("@electric-sql/pglite").then(
    (module) => new module.PGlite(),
    () => {
      shared = undefined;
      throw new OkmError(
        "OKM1848",
        "The scratch check needs a database, and @electric-sql/pglite is not installed.",
        {
          fix: { summary: "Install @electric-sql/pglite, or pass the url of a scratch database." },
        },
      );
    },
  );
  return shared;
}

async function pglite(): Promise<Runner> {
  const database = await openPglite();
  return {
    async run(list) {
      let current = "";
      try {
        await database.exec("begin");
        for (current of list) await database.exec(current);
        return { ok: true };
      } catch (error) {
        return refused(error, current);
      } finally {
        await database.exec("rollback").catch(() => undefined);
      }
    },
    async close() {},
  };
}

async function provisioned(url: string): Promise<Runner> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(driverUrl(url), { max: 1, idle_timeout: 1, onnotice: () => {} });
  return {
    async run(list) {
      let current = "";
      try {
        await sql.begin(async (transaction) => {
          for (current of list) await transaction.unsafe(current);
          throw new Rollback();
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof Rollback) return { ok: true };
        return refused(error, current);
      }
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

class Rollback extends Error {}

function refused(error: unknown, statement: string): ScratchVerdict {
  const code = field(error, "code") ?? field(error, "sqlstate");
  if (code === undefined || !/^[0-9A-Z]{5}$/.test(code)) throw error;
  const message = (field(error, "message") ?? "").split("\n")[0] ?? "";
  return {
    ok: false,
    sqlstate: code,
    statement,
    error: new OkmError("OKM1848", `Postgres refused it: ${message} (SQLSTATE ${code}).`, {
      fix: {
        summary: [
          FIX[code] ?? "Change the statement so Postgres accepts it.",
          ...expressionHints(statement),
        ].join(" "),
      },
    }),
  };
}

/** What the usual refusals mean, so the error says more than the server does. */
const FIX: Readonly<Record<string, string>> = {
  "42P17": "Use only immutable functions here: now(), concat(), and to_char(timestamptz) are not.",
  "42883": "No such function or operator for those types. Cast an operand, or check the name.",
  "42703": "No such column. Check the column name.",
  "42601": "Syntax error. Check the expression.",
};

function expressionHints(statement: string): readonly string[] {
  const text = statement.toLowerCase();
  const hints: string[] = [];
  if (/\b(?:concat_ws|concat|format|array_to_string)\s*\(/.test(text)) {
    hints.push(
      "concat, concat_ws, format, and array_to_string are not immutable. Write || with coalesce.",
    );
  }
  if (/\bto_tsvector\s*\(\s*[^,)]+\)/.test(text)) {
    hints.push(
      "A one-argument to_tsvector is not immutable. Pass the configuration as the first argument.",
    );
  }
  if (/\bto_char\s*\(/.test(text)) {
    hints.push("to_char is not immutable. Use extract.");
  }
  if (/\bdate_trunc\s*\([^)]*\bdate\b/.test(text) || /\bdate_trunc\s*\(/.test(text)) {
    hints.push("date_trunc of a date is not immutable. Cast the date to timestamp first.");
  }
  if (/::\s*date\b/.test(text)) hints.push("text::date is not immutable.");
  if (/\bnow\s*\(/.test(text)) hints.push("now() is not immutable.");
  if (/::\s*timestamptz\b|::\s*timestamp with time zone\b/.test(text)) {
    hints.push("A timestamptz cast is not immutable. Use at time zone 'const'.");
  }
  return hints;
}

function field(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null || !(name in error)) return undefined;
  const value: unknown = (error as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}
