/**
 * Procedure options and `run` inference.
 */

import { expectTypeOf } from "expect-type";

import { fn } from "../src/dialects/pg/fn/index.js";
import { t } from "../src/dialects/pg/index.js";

// @ts-expect-error a procedure has no return type
fn("no_returns", { kind: "procedure", returns: t.integer(), body: "select 1" });

// @ts-expect-error a procedure has no volatility
fn("no_volatility", { kind: "procedure", volatility: "stable", body: "select 1" });

// @ts-expect-error argument types are column builders
fn("string_type", { arguments: [{ name: "title", type: "text" }], returns: t.text(), language: "sql", body: "select 1" });

const closeOne = fn("close_one", {
  kind: "procedure",
  arguments: [
    { name: "account", type: t.text() },
    { name: "closed", type: t.integer(), mode: "out" },
    { name: "units", type: t.bigint(), mode: "out" },
  ],
  body: "select 1",
});

type Closed = Awaited<ReturnType<typeof closeOne.run>>;
expectTypeOf<Closed["closed"]>().toEqualTypeOf<number | null>();
expectTypeOf<Closed["units"]>().toEqualTypeOf<string | null>();
