import { expect, test } from "bun:test";

import { identityKey } from "./canonical.js";
import { assertCatalog, creationOrder, dropOrder, recreatePlan } from "./graph.js";
import { staticNamespace, type CatalogObject } from "./object.js";
import { renderCatalog, renderDrop } from "./render.js";
import { sampleCatalog } from "./sample.js";

test("sample create order respects dependencies and drop order reverses it", () => {
  const objects = sampleCatalog(staticNamespace("app"));
  assertCatalog(objects);
  const create = creationOrder(objects);
  const names = create.map((object) => object.identity.name);
  expect(names.indexOf("email")).toBeLessThan(names.indexOf("tasks"));
  expect(names.indexOf("touch")).toBeLessThan(names.indexOf("tasks_touch"));
  expect(names.indexOf("tasks")).toBeLessThan(names.indexOf("tasks_touch"));
  expect(names.indexOf("events")).toBeLessThan(names.indexOf("events_low"));
  expect(names.indexOf("tasks")).toBeLessThan(names.indexOf("active_tasks"));
  for (const object of objects) {
    for (const edge of object.dependencies) {
      const dependency = create.findIndex(
        (item) => identityKey(item.identity) === identityKey(edge.identity),
      );
      const dependent = create.findIndex(
        (item) => identityKey(item.identity) === identityKey(object.identity),
      );
      expect(dependency).toBeLessThan(dependent);
    }
  }
  expect(dropOrder(objects).map((object) => identityKey(object.identity))).toEqual(
    [...create].reverse().map((object) => identityKey(object.identity)),
  );
});

test("function overloads are distinct identities", () => {
  const slugs = sampleCatalog(staticNamespace("app")).filter(
    (object) => object.identity.name === "slug",
  );
  expect(slugs).toHaveLength(2);
  const first = slugs[0];
  const second = slugs[1];
  if (first === undefined || second === undefined) throw new Error("missing overload");
  expect(identityKey(first.identity)).not.toBe(identityKey(second.identity));
});

test("changing a column recreates only the views that use it", () => {
  const objects = sampleCatalog(staticNamespace("app"));
  const title = objects.find(
    (object) =>
      object.kind === "column" &&
      object.identity.parent === "tasks" &&
      object.identity.name === "title",
  );
  const id = objects.find(
    (object) =>
      object.kind === "column" &&
      object.identity.parent === "tasks" &&
      object.identity.name === "id",
  );
  if (title === undefined || id === undefined) throw new Error("missing column");
  const titlePlan = recreatePlan(objects, title.identity);
  expect(titlePlan.drop.map((object) => object.identity.name).sort()).toEqual([
    "active_tasks",
    "task_titles",
  ]);
  expect(titlePlan.recreate.map((object) => object.identity.name)).toEqual(
    [...titlePlan.drop].reverse().map((object) => object.identity.name),
  );
  const idNames = recreatePlan(objects, id.identity).drop.map((object) => object.identity.name);
  expect(idNames).toContain("active_tasks");
  expect(idNames).not.toContain("task_titles");
});

test("changing a table recreates triggers and views, not its own columns", () => {
  const objects = sampleCatalog(staticNamespace("app"));
  const tasks = objects.find(
    (object) => object.kind === "table" && object.identity.name === "tasks",
  );
  if (tasks === undefined) throw new Error("missing tasks");
  const names = recreatePlan(objects, tasks.identity).drop.map((object) => object.identity.name);
  expect(names).toContain("tasks_touch");
  expect(names).toContain("active_tasks");
  expect(names).toContain("touch");
  expect(names).not.toContain("id");
  expect(names).not.toContain("tasks");
});

test("external and ignored objects are not emitted, and drops do not cascade", () => {
  const namespace = staticNamespace("app");
  const bindings = [{ logical: namespace, concrete: "app_concrete" }];
  const objects = sampleCatalog(namespace).map((object) =>
    object.kind === "view" || object.kind === "policy"
      ? { ...object, owner: "external" as const }
      : object,
  );
  const ignored = objects.map((object) =>
    object.kind === "sequence" ? { ...object, owner: "ignored" as const } : object,
  );
  const sql = renderCatalog(ignored, bindings).join("\n");
  expect(sql).not.toContain("active_tasks");
  expect(sql).not.toContain("tasks_read");
  expect(sql).not.toContain("task_seq");
  expect(sql).toContain("create table");
  expect(renderDrop(sampleCatalog(namespace), bindings).join("\n").toLowerCase()).not.toContain(
    "cascade",
  );
});

test("dependency order is stable for random acyclic catalogs", () => {
  const random = mulberry32(19);
  for (let trial = 0; trial < 40; trial += 1) {
    const count = 25;
    const objects: CatalogObject[] = [];
    for (let index = 0; index < count; index += 1) {
      const deps: string[] = [];
      if (index > 0 && random() < 0.7) {
        deps.push(`n${String(Math.floor(random() * index))}`);
      }
      objects.push(table(`n${String(index)}`, deps));
    }
    const shuffled = shuffle(objects, random);
    const left = creationOrder(objects).map((object) => object.identity.name);
    const right = creationOrder(shuffled).map((object) => object.identity.name);
    expect(right).toEqual(left);
    for (const object of objects) {
      for (const edge of object.dependencies) {
        expect(left.indexOf(edge.identity.name)).toBeLessThan(left.indexOf(object.identity.name));
      }
    }
    expect(dropOrder(shuffled).map((object) => object.identity.name)).toEqual([...left].reverse());
  }
});

test("a dependency cycle is rejected", () => {
  expect(() => creationOrder([table("a", ["b"]), table("b", ["a"])])).toThrow(/cycle/i);
});

test("duplicate identities are rejected", () => {
  expect(() => assertCatalog([table("a", []), table("a", [])])).toThrow(/duplicate/i);
});

function table(name: string, deps: readonly string[]): CatalogObject {
  const namespace = staticNamespace("public");
  return {
    kind: "table",
    identity: { kind: "table", namespace, name },
    owner: "managed",
    definition: { rowSecurity: false },
    dependencies: deps.map((dependency) => ({
      identity: { kind: "table" as const, namespace, name: dependency },
    })),
    provenance: { source: "property" },
  };
}

function shuffle(objects: readonly CatalogObject[], random: () => number): CatalogObject[] {
  const copy = [...objects];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = copy[index];
    const other = copy[swap];
    if (current === undefined || other === undefined) continue;
    copy[index] = other;
    copy[swap] = current;
  }
  return copy;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
