/**
 * Result types of descendants, ancestors, and sync.
 */

import { expectTypeOf } from "expect-type";

import type { Connected } from "../src/runtime/types.js";
import { app } from "./tree-sync-schema.js";

type Scoped = ReturnType<Connected<typeof app>["for"]>;
declare const a: Scoped;

const id = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0c0001";

const rows = a.nodes.descendants(id, { relation: "children", select: ["id", "name"] });
expectTypeOf<keyof Awaited<typeof rows>[number]>().toEqualTypeOf<"id" | "name">();

const full = a.nodes.ancestors(id, { relation: "children" });
expectTypeOf<Awaited<typeof full>[number]["name"]>().toEqualTypeOf<string>();

const synced = a.tags.sync(id, "nodes", [id]);
expectTypeOf<Awaited<typeof synced>["added"]>().toEqualTypeOf<readonly unknown[]>();
expectTypeOf<Awaited<typeof synced>["removed"]>().toEqualTypeOf<readonly unknown[]>();

// @ts-expect-error depth is a number of steps
void a.nodes.descendants(id, { depth: "1" });
