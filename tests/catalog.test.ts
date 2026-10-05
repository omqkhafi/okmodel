import { expect, test } from "bun:test";

import type { CatalogObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/index.js";
import {
  KIND_OPERATIONS,
  OBJECT_KINDS,
  POSTGRES_IDENTIFIER_MAX_BYTES,
  column,
  constraint,
  deterministicName,
  fitIdentifier,
  identifierLimitApplies,
  identityKey,
  index,
  resolveNamespace,
  sequence,
  sha256,
  staticNamespace,
  table,
  templateNamespace,
  utf8ByteLength,
  type Catalog,
  type ObjectRef,
  type Provenance,
} from "../src/contracts/internal.js";
import {
  catalog,
  catalogHash,
  creationOrder,
  parseCatalog,
  renameColumn,
  serializeCatalog,
} from "../src/contracts/catalog/document.js";

const provenance: Provenance = { origin: "file", name: "db/tasks.ts" };
const ns = staticNamespace("public");

/**
 * Reads the spec code from a thrown {@link OkmError}.
 *
 * @param run - Call that should throw
 * @returns The error code
 */
function thrownCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      return error.code;
    }
  }
  throw new Error("expected OkmError");
}

function parent(name: string, namespace = ns): ObjectRef {
  return { namespace, name };
}

test("ownership is stored for managed, external, and ignored", () => {
  const managed = table({ namespace: ns, name: "tasks", provenance });
  const external = table({ namespace: ns, name: "users", provenance, owner: "external" });
  const ignored = table({ namespace: ns, name: "scratch", provenance, owner: "ignored" });
  expect(managed.owner).toBe("managed");
  expect(external.owner).toBe("external");
  expect(ignored.owner).toBe("ignored");
  const built = catalog([ignored, external, managed]);
  const owners = Object.fromEntries(
    built.objects.map((object) => [objectName(object), object.owner]),
  );
  expect(owners).toEqual({ scratch: "ignored", tasks: "managed", users: "external" });
});

test("a partitioned table does not gain copied keys", () => {
  const events = parent("events");
  const built = catalog([
    table({
      namespace: ns,
      name: "events",
      provenance,
      partition: { method: "range", columns: ["id"] },
    }),
    column({ parent: events, name: "id", dataType: "uuid", nullable: false, provenance }),
    constraint({ parent: events, constraintKind: "primaryKey", columns: ["id"], provenance }),
  ]);
  expect(built.objects).toHaveLength(3);
  expect(built.objects.some((object) => objectName(object).includes("low"))).toBe(false);
});

test("snapshots keep the namespace template", () => {
  const namespace = templateNamespace("tenant_{id}");
  const built = catalog([table({ namespace, name: "tasks", provenance })]);
  const text = serializeCatalog(built);
  expect(text).toContain("tenant_{id}");
  expect(text).not.toContain(resolveNamespace(namespace, "acme"));
  const parsed = parseCatalog(text);
  const stored = parsed.objects[0]?.identity;
  expect(stored?.kind).toBe("table");
  if (stored?.kind !== "table") {
    throw new Error("expected a table");
  }
  expect(stored.namespace).toEqual({ form: "template", pattern: "tenant_{id}" });
});

test("a uuid tenant id is written as hex", () => {
  const namespace = templateNamespace("tenant_{id}");
  expect(resolveNamespace(namespace, "550E8400-E29B-41D4-A716-446655440000")).toBe(
    "tenant_550e8400e29b41d4a716446655440000",
  );
  expect(resolveNamespace(namespace, "acme_1")).toBe("tenant_acme_1");
  expect(resolveNamespace(staticNamespace("public"), "ignored")).toBe("public");
});

test("renaming a field keeps constraint and index names", () => {
  const tasks = parent("tasks");
  const users = parent("users");
  const idSequence = sequence({ namespace: ns, name: "tasks_id_seq", provenance });
  const built = catalog([
    table({ namespace: ns, name: "users", provenance, owner: "external" }),
    column({
      parent: users,
      name: "id",
      dataType: "uuid",
      nullable: false,
      provenance,
      owner: "external",
    }),
    table({ namespace: ns, name: "tasks", provenance }),
    idSequence,
    column({
      parent: tasks,
      name: "id",
      dataType: "uuid",
      nullable: false,
      provenance,
      dependencies: [idSequence.identity],
    }),
    column({ parent: tasks, name: "email", dataType: "text", nullable: false, provenance }),
    column({
      parent: users,
      name: "email",
      dataType: "text",
      nullable: true,
      provenance,
      owner: "external",
    }),
    constraint({ parent: tasks, constraintKind: "primaryKey", columns: ["id"], provenance }),
    constraint({
      parent: tasks,
      constraintKind: "unique",
      columns: ["email"],
      nameKey: "email",
      provenance,
    }),
    index({ parent: tasks, columns: ["email"], nameKey: "email", provenance }),
    constraint({
      parent: tasks,
      constraintKind: "foreignKey",
      columns: ["email"],
      nameKey: "user",
      references: { parent: users, columns: ["id"] },
      provenance,
    }),
    constraint({
      parent: tasks,
      constraintKind: "check",
      nameKey: "positionPositive",
      expression: "position >= 0",
      provenance,
    }),
  ]);

  const renamed = renameColumn(built, { parent: tasks, from: "email", to: "contact" });
  const unique = renamed.objects.find(
    (object) => object.kind === "constraint" && object.definition.constraintKind === "unique",
  );
  const fk = renamed.objects.find(
    (object) => object.kind === "constraint" && object.definition.constraintKind === "foreignKey",
  );
  const pk = renamed.objects.find(
    (object) => object.kind === "constraint" && object.definition.constraintKind === "primaryKey",
  );
  const secondary = renamed.objects.find((object) => object.kind === "index");
  const check = renamed.objects.find(
    (object) => object.kind === "constraint" && object.definition.constraintKind === "check",
  );
  expect(unique === undefined ? "" : objectName(unique)).toBe("tasks_email_key");
  expect(unique?.kind === "constraint" ? unique.definition.columns : []).toEqual(["contact"]);
  expect(unique?.kind === "constraint" ? unique.definition.nameKey : "").toBe("email");
  expect(fk === undefined ? "" : objectName(fk)).toBe("tasks_user_fkey");
  expect(fk?.kind === "constraint" ? fk.definition.columns : []).toEqual(["contact"]);
  expect(secondary === undefined ? "" : objectName(secondary)).toBe("tasks_email_idx");
  expect(secondary?.kind === "index" ? secondary.definition.columns : []).toEqual(["contact"]);
  expect(secondary?.kind === "index" ? secondary.definition.nameKey : "").toBe("email");
  expect(check === undefined ? "" : objectName(check)).toBe("tasks_positionPositive_check");
  expect(pk === undefined ? "" : objectName(pk)).toBe("tasks_pkey");
  expect(deterministicName({ parent: "tasks", purpose: "unique", nameKey: "contact" })).not.toBe(
    "tasks_email_key",
  );

  const usersEmail = renamed.objects.find(
    (object) =>
      object.kind === "column" &&
      object.identity.parent.name === "users" &&
      object.identity.name === "email",
  );
  expect(usersEmail).toBeDefined();
  expect(serializeCatalog(renamed)).toBe(serializeCatalog(parseCatalog(serializeCatalog(renamed))));
});

test("a primary key name ignores the column name", () => {
  const tasks = parent("tasks");
  const built = catalog([
    table({ namespace: ns, name: "tasks", provenance }),
    column({ parent: tasks, name: "id", dataType: "uuid", nullable: false, provenance }),
    constraint({ parent: tasks, constraintKind: "primaryKey", columns: ["id"], provenance }),
  ]);
  const renamed = renameColumn(built, { parent: tasks, from: "id", to: "taskId" });
  const pk = renamed.objects.find((object) => object.kind === "constraint");
  expect(pk === undefined ? "" : objectName(pk)).toBe("tasks_pkey");
  expect(pk?.kind === "constraint" ? pk.definition.columns : []).toEqual(["taskId"]);
});

test("create order is dependencies first, then identity key", () => {
  const tied = catalog([
    table({ namespace: ns, name: "b", provenance }),
    table({ namespace: ns, name: "a", provenance }),
  ]);
  expect(creationOrder(tied).map((object) => objectName(object))).toEqual(["a", "b"]);

  const tasks = parent("tasks");
  const built = catalog([
    index({ parent: tasks, columns: ["id"], provenance }),
    column({ parent: tasks, name: "id", dataType: "uuid", nullable: false, provenance }),
    table({ namespace: ns, name: "tasks", provenance }),
  ]);
  const order = creationOrder(built).map((object) => object.kind);
  expect(order).toEqual(["table", "column", "index"]);
});

test("the catalog hash is the canonical bytes", () => {
  const tasks = parent("tasks");
  const first = catalog([
    column({ parent: tasks, name: "id", dataType: "uuid", nullable: false, provenance }),
    table({ namespace: ns, name: "tasks", provenance }),
  ]);
  const second = catalog([
    table({ namespace: ns, name: "tasks", provenance }),
    column({ parent: tasks, name: "id", dataType: "uuid", nullable: false, provenance }),
  ]);
  expect(serializeCatalog(first)).toBe(serializeCatalog(second));
  expect(catalogHash(first)).toBe(sha256(serializeCatalog(first)));
  expect(catalogHash(first)).toBe(catalogHash(second));

  const left = index({ parent: tasks, columns: ["a", "b"], provenance, nameKey: "ab" });
  const right = index({ parent: tasks, columns: ["b", "a"], provenance, nameKey: "ab" });
  const columns = [
    column({ parent: tasks, name: "a", dataType: "text", nullable: false, provenance }),
    column({ parent: tasks, name: "b", dataType: "text", nullable: false, provenance }),
  ];
  const tableObject = table({ namespace: ns, name: "tasks", provenance });
  expect(catalogHash(catalog([tableObject, ...columns, left]))).not.toBe(
    catalogHash(catalog([tableObject, ...columns, right])),
  );
});

test("dependency order does not follow edge order", () => {
  const tasks = parent("tasks");
  const first = sequence({ namespace: ns, name: "first_seq", provenance });
  const second = sequence({ namespace: ns, name: "second_seq", provenance });
  const tableObject = table({ namespace: ns, name: "tasks", provenance });
  const forward = column({
    parent: tasks,
    name: "id",
    dataType: "uuid",
    nullable: false,
    provenance,
    dependencies: [first.identity, second.identity],
  });
  const backward = column({
    parent: tasks,
    name: "id",
    dataType: "uuid",
    nullable: false,
    provenance,
    dependencies: [second.identity, first.identity],
  });
  expect(serializeCatalog(catalog([second, tableObject, forward, first]))).toBe(
    serializeCatalog(catalog([first, backward, second, tableObject])),
  );
});

test("a plain identity key matches canonical JSON", () => {
  expect(identityKey({ kind: "table", namespace: ns, name: "users" })).toBe(
    '{"kind":"table","name":"users","namespace":{"form":"static","name":"public"}}',
  );
  expect(identityKey({ kind: "column", parent: parent("users"), name: "id" })).toBe(
    '{"kind":"column","name":"id","parent":{"name":"users","namespace":{"form":"static","name":"public"}}}',
  );
  expect(identityKey({ kind: "table", namespace: ns, name: 'say "hi"' })).toContain('\\"');
});

test("canonical bytes survive a non-ascii name", () => {
  const built = catalog([table({ namespace: ns, name: "caf\u00e9", provenance })]);
  const text = serializeCatalog(built);
  expect(text).toContain("\\u00e9");
  expect(serializeCatalog(parseCatalog(text))).toBe(text);
  const tasks = parent("tasks");
  const expression = catalog([
    table({ namespace: ns, name: "tasks", provenance }),
    constraint({
      parent: tasks,
      constraintKind: "check",
      nameKey: "positive",
      expression: "a > 0 and b <> 'x'",
      provenance,
    }),
  ]);
  expect(serializeCatalog(parseCatalog(serializeCatalog(expression)))).toBe(
    serializeCatalog(expression),
  );
});

test("fitted names stay distinct under the length limit", () => {
  const left = "a".repeat(80);
  const right = `${"a".repeat(79)}b`;
  const fittedLeft = fitIdentifier(left);
  const fittedRight = fitIdentifier(right);
  expect(fittedLeft).not.toBe(fittedRight);
  expect(utf8ByteLength(fittedLeft)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(utf8ByteLength(fittedRight)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(fitIdentifier("tasks_email_key")).toBe("tasks_email_key");
  expect(deterministicName({ parent: "tasks", purpose: "primaryKey" })).toBe("tasks_pkey");
  const emoji = "\u{1f600}".repeat(20);
  const fitted = fitIdentifier(emoji);
  expect(utf8ByteLength(fitted)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(fitted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test("grant and default-privilege identities skip the length limit", () => {
  expect(identifierLimitApplies("grant")).toBe(false);
  expect(identifierLimitApplies("defaultPrivilege")).toBe(false);
  expect(identifierLimitApplies("table")).toBe(true);
  expect(identifierLimitApplies("constraint")).toBe(true);
  expect(KIND_OPERATIONS.role).toEqual(["create", "alter"]);
  expect(KIND_OPERATIONS.view).toContain("replace");
  expect(KIND_OPERATIONS.materializedView).not.toContain("replace");
  expect(OBJECT_KINDS).toContain("function");
  expect(OBJECT_KINDS).toContain("extension");
});

test("OKM1122 rejects an empty identifier", () => {
  expect(thrownCode(() => table({ namespace: ns, name: "", provenance }))).toBe("OKM1122");
});

test("OKM1122 rejects NUL", () => {
  expect(thrownCode(() => table({ namespace: ns, name: "a\u0000b", provenance }))).toBe("OKM1122");
});

test("OKM1122 rejects a control character", () => {
  expect(thrownCode(() => table({ namespace: ns, name: "a\nb", provenance }))).toBe("OKM1122");
});

test("OKM1122 rejects a name past the dialect limit", () => {
  expect(thrownCode(() => table({ namespace: ns, name: "a".repeat(64), provenance }))).toBe(
    "OKM1122",
  );
});

test("OKM1122 rejects an unquoted reserved word", () => {
  expect(thrownCode(() => table({ namespace: ns, name: "table", provenance }))).toBe("OKM1122");
  expect(thrownCode(() => table({ namespace: ns, name: "Select", provenance }))).toBe("OKM1122");
  expect(thrownCode(() => staticNamespace("user"))).toBe("OKM1122");
});

test("OKM1122 rejects a namespace template without a placeholder", () => {
  expect(thrownCode(() => templateNamespace("public"))).toBe("OKM1122");
  expect(thrownCode(() => templateNamespace("tenant {id}"))).toBe("OKM1122");
});

test("OKM1122 rejects a tenant id that cannot enter an identifier", () => {
  const namespace = templateNamespace("tenant_{id}");
  expect(thrownCode(() => resolveNamespace(namespace, "Acme"))).toBe("OKM1122");
  expect(thrownCode(() => resolveNamespace(namespace, ""))).toBe("OKM1122");
});

test("OKM1122 rejects a resolved namespace past the limit", () => {
  const namespace = templateNamespace("tenant_{id}");
  expect(thrownCode(() => resolveNamespace(namespace, "a".repeat(60)))).toBe("OKM1122");
});

test("OKM1122 rejects an identifier limit shorter than the hash suffix", () => {
  expect(thrownCode(() => fitIdentifier("abcdef", 8))).toBe("OKM1122");
});

test("OKM1023 rejects a duplicate identity", () => {
  const object = table({ namespace: ns, name: "tasks", provenance });
  expect(thrownCode(() => catalog([object, object]))).toBe("OKM1023");
});

test("OKM1020 rejects a missing parent", () => {
  expect(
    thrownCode(() =>
      catalog([
        column({
          parent: parent("tasks"),
          name: "id",
          dataType: "uuid",
          nullable: false,
          provenance,
        }),
      ]),
    ),
  ).toBe("OKM1020");
});

test("OKM1020 rejects a missing dependency", () => {
  const tasks = parent("tasks");
  const missing = sequence({ namespace: ns, name: "tasks_id_seq", provenance });
  expect(
    thrownCode(() =>
      catalog([
        table({ namespace: ns, name: "tasks", provenance }),
        column({
          parent: tasks,
          name: "id",
          dataType: "uuid",
          nullable: false,
          provenance,
          dependencies: [missing.identity],
        }),
      ]),
    ),
  ).toBe("OKM1020");
});

test("OKM1020 rejects an index column that is not in the catalog", () => {
  const tasks = parent("tasks");
  expect(
    thrownCode(() =>
      catalog([
        table({ namespace: ns, name: "tasks", provenance }),
        index({ parent: tasks, columns: ["gone"], provenance }),
      ]),
    ),
  ).toBe("OKM1020");
});

test("OKM1026 rejects a dependency cycle", () => {
  const tasks = parent("tasks");
  const left = { kind: "column" as const, parent: tasks, name: "alpha" };
  const right = { kind: "column" as const, parent: tasks, name: "beta" };
  expect(
    thrownCode(() =>
      catalog([
        table({ namespace: ns, name: "tasks", provenance }),
        column({
          parent: tasks,
          name: "alpha",
          dataType: "text",
          nullable: false,
          provenance,
          dependencies: [right],
        }),
        column({
          parent: tasks,
          name: "beta",
          dataType: "text",
          nullable: false,
          provenance,
          dependencies: [left],
        }),
      ]),
    ),
  ).toBe("OKM1026");
});

test("OKM1020 rejects a self-dependency", () => {
  const tasks = parent("tasks");
  const self = { kind: "column" as const, parent: tasks, name: "id" };
  expect(
    thrownCode(() =>
      catalog([
        table({ namespace: ns, name: "tasks", provenance }),
        column({
          parent: tasks,
          name: "id",
          dataType: "uuid",
          nullable: false,
          provenance,
          dependencies: [self],
        }),
      ]),
    ),
  ).toBe("OKM1020");
});

test("OKM1021 rejects a foreign key without a target", () => {
  const tasks = parent("tasks");
  expect(
    thrownCode(() =>
      constraint({
        parent: tasks,
        constraintKind: "foreignKey",
        columns: ["ownerId"],
        provenance,
      }),
    ),
  ).toBe("OKM1021");
});

test("OKM1021 rejects a foreign key whose column is missing", () => {
  const tasks = parent("tasks");
  const users = parent("users");
  expect(
    thrownCode(() =>
      catalog([
        table({ namespace: ns, name: "users", provenance }),
        column({ parent: users, name: "id", dataType: "uuid", nullable: false, provenance }),
        table({ namespace: ns, name: "tasks", provenance }),
        column({ parent: tasks, name: "ownerId", dataType: "uuid", nullable: false, provenance }),
        constraint({
          parent: tasks,
          constraintKind: "foreignKey",
          columns: ["ownerId"],
          references: { parent: users, columns: ["missing"] },
          provenance,
        }),
      ]),
    ),
  ).toBe("OKM1021");
});

test("OKM1027 rejects catalog JSON that is not valid", () => {
  expect(thrownCode(() => parseCatalog("{"))).toBe("OKM1027");
  expect(thrownCode(() => parseCatalog("null"))).toBe("OKM1027");
  expect(thrownCode(() => parseCatalog("[]"))).toBe("OKM1027");
});

test("OKM1027 rejects an unsupported catalog version", () => {
  const text = serializeCatalog(catalog([table({ namespace: ns, name: "tasks", provenance })]));
  const document = JSON.parse(text) as { version: number; extra?: boolean };
  document.version = 2;
  expect(thrownCode(() => parseCatalog(JSON.stringify(document)))).toBe("OKM1027");
  document.version = 1;
  document.extra = true;
  expect(thrownCode(() => parseCatalog(JSON.stringify(document)))).toBe("OKM1027");
});

test("OKM1020 rejects a kind that does not match its identity", () => {
  const text = serializeCatalog(catalog([table({ namespace: ns, name: "tasks", provenance })]));
  const document = JSON.parse(text) as { objects: { kind: string }[] };
  const object = document.objects[0];
  if (object === undefined) {
    throw new Error("expected an object");
  }
  object.kind = "column";
  expect(thrownCode(() => parseCatalog(JSON.stringify(document)))).toBe("OKM1020");
});

test("OKM1020 rejects an unknown owner and an unbuilt kind", () => {
  const text = serializeCatalog(catalog([table({ namespace: ns, name: "tasks", provenance })]));
  const document = JSON.parse(text) as { objects: { owner: string; kind: string }[] };
  const object = document.objects[0];
  if (object === undefined) {
    throw new Error("expected an object");
  }
  object.owner = "shared";
  expect(thrownCode(() => parseCatalog(JSON.stringify(document)))).toBe("OKM1020");
  object.owner = "managed";
  object.kind = "view";
  expect(thrownCode(() => parseCatalog(JSON.stringify(document)))).toBe("OKM1020");
});

test("OKM1020 rejects a rename of a missing column and OKM1023 a collision", () => {
  const tasks = parent("tasks");
  const built = catalog([
    table({ namespace: ns, name: "tasks", provenance }),
    column({ parent: tasks, name: "email", dataType: "text", nullable: false, provenance }),
    column({ parent: tasks, name: "contact", dataType: "text", nullable: false, provenance }),
  ]);
  expect(thrownCode(() => renameColumn(built, { parent: tasks, from: "gone", to: "next" }))).toBe(
    "OKM1020",
  );
  expect(
    thrownCode(() => renameColumn(built, { parent: tasks, from: "email", to: "contact" })),
  ).toBe("OKM1023");
});

test("OKM1020 rejects a column with two value sources", () => {
  expect(
    thrownCode(() =>
      column({
        parent: parent("tasks"),
        name: "id",
        dataType: "uuid",
        nullable: false,
        provenance,
        defaultExpression: "1",
        generated: { stored: true, expression: "1" },
      }),
    ),
  ).toBe("OKM1020");
});

test("OKM1020 rejects initially deferred without deferrable", () => {
  expect(
    thrownCode(() =>
      constraint({
        parent: parent("tasks"),
        constraintKind: "unique",
        columns: ["email"],
        initially: "deferred",
        provenance,
      }),
    ),
  ).toBe("OKM1020");
});

test("OKM1020 rejects nulls not distinct on a check", () => {
  expect(
    thrownCode(() =>
      constraint({
        parent: parent("tasks"),
        constraintKind: "check",
        nameKey: "positive",
        expression: "position >= 0",
        nullsNotDistinct: true,
        provenance,
      }),
    ),
  ).toBe("OKM1020");
});

test("OKM1020 rejects a check without an expression", () => {
  expect(
    thrownCode(() =>
      constraint({
        parent: parent("tasks"),
        constraintKind: "check",
        nameKey: "positive",
        provenance,
      }),
    ),
  ).toBe("OKM1020");
});

test("OKM1020 rejects an empty column type, a bad sequence, and an empty partition", () => {
  expect(
    thrownCode(() =>
      column({
        parent: parent("tasks"),
        name: "id",
        dataType: "",
        nullable: false,
        provenance,
      }),
    ),
  ).toBe("OKM1020");
  expect(
    thrownCode(() => sequence({ namespace: ns, name: "tasks_id_seq", start: "1.5", provenance })),
  ).toBe("OKM1020");
  expect(
    thrownCode(() => sequence({ namespace: ns, name: "tasks_id_seq", increment: "0", provenance })),
  ).toBe("OKM1020");
  expect(
    thrownCode(() =>
      table({
        namespace: ns,
        name: "events",
        provenance,
        partition: { method: "range", columns: [] },
      }),
    ),
  ).toBe("OKM1020");
});

test("a built catalog round-trips to the same bytes", () => {
  const built: Catalog = catalog([
    table({
      namespace: templateNamespace("tenant_{id}"),
      name: "tasks",
      provenance: { origin: "trait", name: "timestamps" },
      partition: { method: "hash", columns: ["id"] },
    }),
    column({
      parent: { namespace: templateNamespace("tenant_{id}"), name: "tasks" },
      name: "id",
      dataType: "uuid",
      nullable: false,
      provenance: { origin: "extension", name: "pgcrypto" },
      identity: { always: true },
    }),
  ]);
  expect(serializeCatalog(parseCatalog(serializeCatalog(built)))).toBe(serializeCatalog(built));
  expect(catalogHash(parseCatalog(serializeCatalog(built)))).toBe(catalogHash(built));
});

function objectName(object: CatalogObject): string {
  switch (object.kind) {
    case "grant":
    case "defaultPrivilege":
      return "";
    default:
      return object.identity.name;
  }
}
