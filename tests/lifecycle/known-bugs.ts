/**
 * Open migration-lifecycle bugs the property test may hit.
 *
 * A failure matches only when its message contains a listed needle and the
 * case carries that bug's feature. Tags alone never skip a case. Entries the
 * grammar cannot produce are omitted. Product bugs stay; generator mistakes
 * are fixed in the grammar instead.
 */

/** One known open bug the lifecycle property may encounter. */
export type KnownBug = {
  /** Stable id. `NEW-*` is a bug found by this property. */
  readonly id: string;
  /** What the case must be doing. */
  readonly feature: string;
  /** Feature tags that must all be present on the case. */
  readonly tags: readonly string[];
  /** Substrings of the failure message. One is enough, and one is required. */
  readonly messages: readonly string[];
  /** Command that failed. */
  readonly channel: string;
  /** Copyable repro, at most 15 lines. */
  readonly repro: string;
};

/**
 * Bugs this property can still reach.
 *
 * N-10, N-11, N-102, N-118, N-119, and N-123 were fixed by #537.
 * N-35 (varchar picklist / IN check, OKM1520), N-36 (CASE check, OKM1122),
 * N-37 (`picklist().array()`, malformed array literal), N-126 (OKM1531
 * own-column exemption), and N-135 (INVALID index after a killed build) are
 * real bugs this grammar does not generate. NEW-2 (quoted generated
 * expression) is reprinted on a scratch column, so it is not listed.
 */
export const KNOWN_BUGS: readonly KnownBug[] = [
  {
    id: "NEW-3",
    feature: "okm check on a hot standby reprints an expression onto a temporary table",
    tags: ["role-replica"],
    messages: ["OKM1896"],
    channel: "okm check --target replica",
    repro: [
      "// channel: okm check --target replica",
      'const tasks = table("tasks", { id: t.identity().primaryKey(), title: t.text() });',
      'const touch = fn("touch", { returns: "trigger", language: "plpgsql", body: "begin return new; end", dependsOn: [tasks] });',
      'const trig = trigger("tasks_when", { on: tasks, timing: "before", events: ["update"], level: "row", calls: touch, when: "OLD.title IS DISTINCT FROM NEW.title" });',
      "export const app = schema({ tables: [tasks], functions: [touch], triggers: [trig] });",
      "// OKM1896: hot standby cannot create the temporary table used to reprint WHEN",
    ].join("\n"),
  },
  {
    id: "NEW-4",
    feature:
      "a NOSUPERUSER with CREATE on the schema only cannot open the migrate-check scratch schema",
    tags: ["role-creator"],
    messages: ["permission denied for database"],
    channel: "okm migrate check",
    repro: [
      "// channel: okm migrate check",
      "// role: NOSUPERUSER, CREATE on schema public, no CREATE on the database",
      'const tasks = table("tasks", { id: t.identity().primaryKey(), title: t.text() });',
      "export const app = schema({ tables: [tasks] });",
      "// driver: permission denied for database <name>",
      "// migrate check creates okm_check_<uuid>, which needs CREATE on the database",
    ].join("\n"),
  },
  {
    id: "NEW-5",
    feature: "apply does not get past an index that already uses the compiler's name",
    tags: ["clash-index"],
    messages: ["already exists"],
    channel: "okm migrate apply",
    repro: [
      "// channel: okm migrate apply",
      "// index tasks_code_idx already exists in the schema (here, on okm_steps)",
      'const tasks = table("tasks", {',
      "  id: t.identity().primaryKey(),",
      "  code: t.text(),",
      "}, { indexes: (columns) => [index(columns.code).unique()] });",
      "export const app = schema({ tables: [tasks] });",
      '// driver: relation "tasks_code_idx" already exists',
    ].join("\n"),
  },
  {
    id: "NEW-6",
    feature: "okm check seals a view by creating okm_view_seal, which a hot standby rejects",
    tags: ["role-replica", "view"],
    messages: ["cannot execute CREATE SCHEMA in a read-only transaction"],
    channel: "okm check --target replica",
    repro: [
      "// channel: okm check --target replica",
      'const tasks = table("tasks", { id: t.identity().primaryKey(), title: t.text() });',
      'const ids = view("task_ids", (q) => q.from(tasks, ["id"]));',
      "export const app = schema({ tables: [tasks], views: [ids] });",
      "// driver: cannot execute CREATE SCHEMA in a read-only transaction",
      "// check creates schema okm_view_seal to seal the view",
    ].join("\n"),
  },
];

/**
 * The first known bug that matches a failed case, if any.
 *
 * @param tags - Feature tags present on the case
 * @param message - Failure message, including the OKM code when there is one
 * @returns The matching entry, or undefined
 */
export function matchKnownBug(tags: readonly string[], message: string): KnownBug | undefined {
  const present = new Set(tags);
  for (const bug of KNOWN_BUGS) {
    if (bug.messages.length === 0 || bug.tags.length === 0) continue;
    if (!bug.messages.some((needle) => message.includes(needle))) continue;
    if (!bug.tags.every((tag) => present.has(tag))) continue;
    return bug;
  }
  return undefined;
}
