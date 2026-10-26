/**
 * Columns and constraints `okm pull` listed and did not write.
 *
 * The record is `.okm/pull.json` at the project root, including when `--out`
 * writes the schema somewhere else for the same target. A scratch `--out` of
 * another target or an explicit `--schema` does not replace it. Push refuses
 * a plan that drops one of them (OKM1897). Check omits them, so an ok report
 * does not list those drops.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { identityKey } from "../../contracts/catalog/identity.js";
import { identitySequenceName } from "../../contracts/catalog/identifier.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import { dropObjectSql } from "../../dialects/pg/ddl.js";
import type { PlanStep } from "./plan.js";
import type { PullSkip } from "./pull-emit.js";

/** Project-relative path of the pull record. */
export const PULL_RECORD = ".okm/pull.json";

/** One column or constraint pull reported and did not write. */
export type UnpulledObject = {
  readonly kind: "column" | "constraint";
  readonly key: string;
  readonly label: string;
};

/**
 * Replaces `.okm/pull.json` with the columns and constraints in `skipped`.
 *
 * An empty list clears an older record. Policies and other kinds stay out:
 * check already omits unmanaged policies on its own.
 *
 * @param cwd - Project directory
 * @param skipped - Objects the pull report listed
 */
export function writeUnpulled(cwd: string, skipped: readonly PullSkip[]): void {
  const objects = skipped
    .filter(
      (item): item is PullSkip & { readonly kind: "column" | "constraint" } =>
        item.kind === "column" || item.kind === "constraint",
    )
    .map((item) => ({ kind: item.kind, key: item.key, label: item.label }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const path = join(cwd, PULL_RECORD);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, objects }, null, 2)}\n`);
}

/**
 * Reads `.okm/pull.json`.
 *
 * A missing file is an empty list. A file that is not this record is refused.
 *
 * @param cwd - Project directory
 * @returns Columns and constraints pull left behind
 */
export function readUnpulled(cwd: string): readonly UnpulledObject[] {
  const path = join(cwd, PULL_RECORD);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return parseUnpulled(text, path);
}

/**
 * Identity keys from {@link readUnpulled}.
 *
 * @param objects - Pull record
 * @returns Keys check omits from the live catalog
 */
export function unpulledKeys(objects: readonly UnpulledObject[]): ReadonlySet<string> {
  return new Set(objects.map((item) => item.key));
}

/**
 * Drops live columns and constraints pull did not write.
 *
 * An identity column also drops the sequence it owns. That sequence is not
 * in the record. It is omitted with the column, so check does not list it.
 *
 * @param live - Introspected catalog
 * @param keys - {@link unpulledKeys}
 * @returns `live` when nothing matches
 */
export function withoutUnpulled(live: Catalog, keys: ReadonlySet<string>): Catalog {
  if (keys.size === 0) return live;
  const sequences = new Set<string>();
  for (const object of live.objects) {
    if (object.kind !== "column" || object.definition.identity === undefined) continue;
    if (!keys.has(identityKey(object.identity))) continue;
    sequences.add(identitySequenceName(object.identity.parent.name, object.identity.name));
  }
  const objects = live.objects.filter((object) => {
    if (keys.has(identityKey(object.identity))) return false;
    return object.kind !== "sequence" || !sequences.has(object.identity.name);
  });
  if (objects.length === live.objects.length) return live;
  return { version: live.version, objects };
}

/**
 * Labels of unpulled columns and constraints whose drop is in `steps`.
 *
 * @param steps - Planned statements
 * @param live - Introspected catalog the plan was built from
 * @param objects - Pull record
 * @param schema - Concrete schema the plan qualified
 * @returns Labels, in catalog order
 */
export function unpulledDropLabels(
  steps: readonly PlanStep[],
  live: Catalog,
  objects: readonly UnpulledObject[],
  schema: string,
): readonly string[] {
  if (objects.length === 0 || steps.length === 0) return [];
  const byKey = new Map(objects.map((item) => [item.key, item.label]));
  const drops = new Set(
    steps
      .filter((step) => step.kind === "drop-column" || step.kind === "drop-constraint")
      .map((step) => step.sql),
  );
  if (drops.size === 0) return [];
  const labels: string[] = [];
  for (const object of live.objects) {
    if (object.kind !== "column" && object.kind !== "constraint") continue;
    const label = byKey.get(identityKey(object.identity));
    if (label === undefined) continue;
    const sql = dropObjectSql(object, schema);
    if (sql !== undefined && drops.has(sql)) labels.push(label);
  }
  return labels;
}

/**
 * Refuses a push that would drop objects pull left behind.
 *
 * @param labels - {@link unpulledDropLabels}
 */
export function refuseUnpulledDrops(labels: readonly string[]): void {
  if (labels.length === 0) return;
  throw new OkmError(
    "OKM1897",
    `okm push would drop ${labels.join(", ")}, which okm pull left under not pulled yet.`,
    {
      fix: {
        summary:
          "Those columns and constraints stay in the database. Pull did not write them, so push does not drop them.",
      },
    },
  );
}

function parseUnpulled(text: string, path: string): readonly UnpulledObject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidPullRecord(path);
  }
  if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["objects"])) {
    throw invalidPullRecord(path);
  }
  const objects: UnpulledObject[] = [];
  for (const item of parsed["objects"]) {
    if (!isRecord(item)) throw invalidPullRecord(path);
    const kind = item["kind"];
    const key = item["key"];
    const label = item["label"];
    if (
      (kind !== "column" && kind !== "constraint") ||
      typeof key !== "string" ||
      key.length === 0
    ) {
      throw invalidPullRecord(path);
    }
    if (typeof label !== "string" || label.length === 0) throw invalidPullRecord(path);
    objects.push({ kind, key, label });
  }
  return objects;
}

function invalidPullRecord(path: string): OkmError {
  return new OkmError("invalid", `${path} is not an okm pull record.`, {
    fix: { summary: "Run okm pull again, or delete the file. Push and check read it." },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
