/**
 * Catalog documents.
 *
 * `catalog` checks identity, foreign keys, and cycles, then stores objects in
 * identity-key order. The serialized form is the canonical JSON of that
 * document, templates included. The hash is SHA-256 of those bytes.
 */

import { catalogError } from "../error.js";
import { heldIndex } from "./held.js";
import { assertCommentText, identitySequenceName } from "./identifier.js";
import { sha256 } from "../sha256.js";
import { canonicalJson, type Json } from "./json.js";
import { replaceIdentifier } from "./rewrite.js";
import {
  identityKey,
  identityLabel,
  identityToJson,
  namespaceToJson,
  sameNamespace,
  sameRef,
  staticNamespace,
  templateNamespace,
} from "./identity.js";
import { catalog } from "./build.js";
import { compositeType, isComposite } from "./composite.js";
import { domainType, enumType, isDomain } from "./enum.js";
import { isRange, rangeType } from "./range.js";
import { extensionObject } from "./extension.js";
import { defaultPrivilegeObject, grantObject, roleObject } from "./privilege.js";
import { eventTriggerObject } from "./event-trigger.js";
import { functionObject, retargetFunction, triggerObject } from "./routine.js";
import { policyObject } from "./policy.js";
import { materializedViewIndex, materializedViewObject, viewObject } from "./view.js";
import {
  column,
  compareText,
  constraint,
  identityFields,
  index,
  sequence,
  sequenceBounds,
  table,
} from "./object.js";
import { withUnvalidatedNotNull } from "./not-null.js";
import { dependencyOrder } from "./order.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  DependencyEdge,
  GrantObjectRef,
  IndexElement,
  IndexObject,
  MaterializedViewObject,
  Namespace,
  ObjectIdentity,
  ObjectRef,
  Owner,
  PartitionBound,
  PartitionRule,
  Provenance,
  ExtensionObject,
  SequenceObject,
  SeriesDefinition,
  SeriesReset,
  TableDefinition,
  TableObject,
  ViewObject,
} from "./types.js";
import {
  BUILT_KINDS,
  CATALOG_VERSION,
  OWNERS,
  referentialAction,
  type ReferentialAction,
} from "./types.js";

export { catalog };

/**
 * Create order for a catalog.
 *
 * Ties break by identity key.
 *
 * @param source - Catalog document
 * @returns Dependencies first
 */
export function creationOrder(source: Catalog): readonly CatalogObject[] {
  return dependencyOrder(source.objects);
}

/**
 * Renames a column without renaming constraints or indexes.
 *
 * Column lists and edges that pointed at the old column move to the new name.
 * `nameKey` and the stored constraint or index name stay as they were.
 *
 * @param source - Catalog document
 * @param change - Parent table, current column name, and the new name
 * @returns A new catalog
 */
export function renameColumn(
  source: Catalog,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
): Catalog {
  const fromIdentity: ObjectIdentity = {
    kind: "column",
    parent: change.parent,
    name: change.from,
  };
  const toIdentity: ObjectIdentity = {
    kind: "column",
    parent: change.parent,
    name: change.to,
  };
  const fromKey = identityKey(fromIdentity);
  const found = source.objects.some((object) => identityKey(object.identity) === fromKey);
  if (!found) {
    catalogError("OKM1020", `Column ${change.from} is not in the catalog.`);
  }
  const next = source.objects.map((object) => rewriteRenamed(object, change, fromKey, toIdentity));
  return catalog(next);
}

/**
 * Renames a table without renaming its constraints or indexes.
 *
 * Column, index, constraint, and trigger parents move to the new name, and
 * edges that pointed at those objects move with them. Expression text that
 * names the table is rewritten on a check, an index, a policy, or a view.
 * A function body and a trigger `when` stay as stored: Postgres does not
 * rewrite that source, so the planner recreates the routine. Constraint and
 * index names stay. A grant on
 * the table, or on an identity sequence named `{table}_{column}_seq`, follows
 * the name the schema will use. The planner emits the `RENAME` for a default
 * name; a custom name is left as it is.
 *
 * @param source - Catalog document
 * @param change - Namespace, current table name, and the new name
 * @returns A new catalog
 */
export function renameTable(
  source: Catalog,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
): Catalog {
  const fromIdentity: ObjectIdentity = {
    kind: "table",
    namespace: change.namespace,
    name: change.from,
  };
  const toIdentity: ObjectIdentity = {
    kind: "table",
    namespace: change.namespace,
    name: change.to,
  };
  const fromKey = identityKey(fromIdentity);
  const found = source.objects.some((object) => identityKey(object.identity) === fromKey);
  if (!found) {
    catalogError("OKM1020", `Table ${change.from} is not in the catalog.`);
  }
  const next = source.objects.map((object) =>
    rewriteTableName(object, change, fromKey, toIdentity, source),
  );
  return catalog(next);
}

/**
 * Canonical JSON for a catalog.
 *
 * Templates stay templates. Object keys are sorted and objects are ordered by
 * identity key, so input order does not change the bytes.
 *
 * @param source - Catalog document
 * @returns Canonical text
 */
const serializedText = new WeakMap<Catalog, string>();
const serializedHash = new WeakMap<Catalog, string>();

export function serializeCatalog(source: Catalog): string {
  settleChecks(source);
  const cached = serializedText.get(source);
  if (cached !== undefined) return cached;
  const indexed = source.objects.map((object) => ({
    object,
    key: identityKey(object.identity),
  }));
  indexed.sort((left, right) => compareText(left.key, right.key));
  const text = canonicalJson({
    objects: indexed.map((item) => objectToJson(item.object)),
    version: source.version,
  });
  serializedText.set(source, text);
  return text;
}

/**
 * SHA-256 of {@link serializeCatalog}.
 *
 * The hash covers the normalised structure. It does not cover a separate
 * authoring document.
 *
 * @param source - Catalog document
 * @returns Lowercase hex digest
 */
export function catalogHash(source: Catalog): string {
  for (const object of source.objects) {
    if (
      object.kind === "column" &&
      object.definition.generated !== undefined &&
      heldIndex(object.definition.generated.expression) !== undefined
    ) {
      catalogError(
        "OKM1020",
        `Column ${object.identity.parent.name}.${object.identity.name} still has an unprinted generated expression.`,
      );
    }
  }
  const cached = serializedHash.get(source);
  if (cached !== undefined) return cached;
  const hash = sha256(serializeCatalog(source));
  serializedHash.set(source, hash);
  return hash;
}

/**
 * The catalog `connect()` compares with `okm_meta` (D208).
 *
 * Roles, grants, and default privileges come from the migration config, not
 * the schema, so they are left out. A `schema()` catalog never has them, so
 * `connect()` hashes it unchanged. `okm check` still verifies them. An
 * `external` or `ignored` owner is planning state. The startup copy writes
 * it back to `managed`, which is what `schema()` stored. A catalog with
 * neither privileges nor those owners is returned as is.
 *
 * @param source - Catalog document
 * @returns The catalog `connect()` hashes
 */
export function startupCatalog(source: Catalog): Catalog {
  let privileges = false;
  let foreign = false;
  for (const object of source.objects) {
    if (isPrivilege(object)) privileges = true;
    else if (object.owner !== "managed") foreign = true;
    if (privileges && foreign) break;
  }
  if (!privileges && !foreign) return source;
  return {
    version: source.version,
    objects: source.objects.flatMap((item) => {
      if (isPrivilege(item)) return [];
      if (item.owner === "managed") return [item];
      return [{ ...item, owner: "managed" as const }];
    }),
  };
}

/**
 * {@link catalogHash} of {@link startupCatalog}. The hash `okm_meta` and
 * `okm_history` store, and the one `connect()` computes.
 *
 * @param source - Catalog document
 * @returns Lowercase hex digest
 */
export function startupHash(source: Catalog): string {
  return catalogHash(startupCatalog(source));
}

/** Copies a startup `enforced` flag onto `definition.enforced`. */
export function settleChecks(source: Catalog): Catalog {
  for (const object of source.objects) {
    if (object.kind !== "constraint") continue;
    if ((object as { enforced?: boolean }).enforced !== false) continue;
    (object.definition as { enforced?: false }).enforced = false;
  }
  return source;
}

function markEnforced<T extends CatalogObject>(object: T, enforced: boolean | undefined): T {
  if (object.kind === "constraint" && enforced === false) {
    (object.definition as { enforced?: false }).enforced = false;
  }
  return object;
}

function isPrivilege(object: CatalogObject): boolean {
  return object.kind === "role" || object.kind === "grant" || object.kind === "defaultPrivilege";
}

/**
 * Loads a build artifact without validating objects.
 *
 * `okm build` already validated the catalog. Production startup checks the
 * stored hash and the version, then trusts the objects (D133). `okm check`
 * and dev keep {@link parseCatalog}.
 *
 * @param text - Catalog JSON. A BOM is stripped and `\r` is removed before the hash check
 * @param hash - SHA-256 of that normalized text, stored beside the artifact
 * @returns The catalog document
 */
export function loadTrustedCatalog(text: string, hash: string): Catalog {
  const canonical = catalogFileText(text);
  if (sha256(canonical) !== hash) {
    catalogError("OKM1027", "Catalog hash does not match the build artifact.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    catalogError("OKM1027", "Catalog text is not valid JSON.");
  }
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.objects)) {
    catalogError("OKM1027", "Catalog document is not an object.");
  }
  if (parsed.version !== CATALOG_VERSION) {
    catalogError(
      "OKM1027",
      `Catalog version ${String(parsed.version)} cannot be read. This build reads version ${String(CATALOG_VERSION)}.`,
    );
  }
  const loaded: Catalog = {
    version: CATALOG_VERSION,
    objects: parsed.objects as Catalog["objects"],
  };
  serializedText.set(loaded, canonical);
  serializedHash.set(loaded, hash);
  return loaded;
}

/**
 * Catalog file bytes the hash covers.
 *
 * A leading UTF-8 BOM is dropped. Carriage returns are removed, so a CRLF
 * checkout hashes like the LF file the writer stored. An LF file is unchanged.
 * UTF-16 is OKM1027.
 *
 * @param text - Raw catalog JSON or hash file
 * @param label - Name used when the text is UTF-16
 * @returns Text to hash and parse
 */
export function catalogFileText(text: string, label = "Catalog text"): string {
  if (text.includes("\u0000")) {
    catalogError("OKM1027", `${label} is UTF-16. Save the file as UTF-8.`, {
      fieldReason: "utf16",
      fix: { summary: "Save the file as UTF-8. This version does not read UTF-16." },
    });
  }
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replaceAll("\r", "");
}

/**
 * Reads canonical catalog JSON.
 *
 * @param text - Serialized catalog
 * @returns A checked catalog
 */
export function parseCatalog(text: string): Catalog {
  const canonical = catalogFileText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    catalogError("OKM1027", "Catalog text is not valid JSON.");
  }
  if (!isPlainRecord(parsed)) {
    catalogError("OKM1027", "Catalog document is not an object.");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "objects" && key !== "version") {
      catalogError("OKM1027", `Catalog has unexpected field ${key}.`);
    }
  }
  if (parsed.version !== CATALOG_VERSION) {
    catalogError(
      "OKM1027",
      `Catalog version ${String(parsed.version)} cannot be read. This build reads version ${String(CATALOG_VERSION)}.`,
    );
  }
  if (!Array.isArray(parsed.objects)) {
    catalogError("OKM1027", "Catalog field objects must be an array.");
  }
  return catalog(parsed.objects.map((item) => parseObject(item)));
}

function rewriteRenamed(
  object: CatalogObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  fromKey: string,
  toIdentity: ObjectIdentity,
): CatalogObject {
  const next = rewriteRenamedObject(object, change, fromKey, toIdentity);
  return object.comment === undefined ? next : { ...next, comment: object.comment };
}

function rewriteRenamedObject(
  object: CatalogObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  fromKey: string,
  toIdentity: ObjectIdentity,
): CatalogObject {
  const dependencies = retarget(object.dependencies, fromKey, toIdentity);
  switch (object.kind) {
    case "table":
      return rewriteTable(object, change, dependencies);
    case "column":
      return rewriteColumn(object, change, dependencies);
    case "index":
      return rewriteIndex(object, change, dependencies);
    case "constraint":
      return rewriteConstraint(object, change, dependencies);
    case "sequence":
      return rewriteSequence(object, dependencies);
    case "type":
      return rewriteType(object, dependencies);
    case "extension":
      return retargeted(object, dependencies);
    case "function":
      return retargetFunction(object, dependencies, object.definition.body);
    case "view":
    case "materializedView": {
      const local = object.dependencies.some(
        (edge) => edge.target.kind === "column" && sameRef(edge.target.parent, change.parent),
      );
      return rewriteView(object, dependencies, rewriteExpr(object.definition.query, change, local));
    }
    case "role":
    case "grant":
    case "defaultPrivilege":
    case "eventTrigger":
      return retargeted(object, dependencies);
    case "policy":
      return rewritePolicyColumn(object, change, dependencies);
    case "trigger": {
      // `triggerObject` reads `when` and adds a column edge for each name.
      // The old text still names the column this rename removed, so the
      // record is copied and only `updateOf` moves. Postgres rewrites that
      // list itself. It does not rewrite `when`.
      const local = sameRef(object.identity.parent, change.parent);
      const updateOf = object.definition.updateOf;
      return {
        ...object,
        definition:
          updateOf === undefined
            ? object.definition
            : {
                ...object.definition,
                updateOf: local ? renameList(updateOf, change.from, change.to) : updateOf,
              },
        dependencies: dependencies.map((target) => ({ target })),
      };
    }
    default:
      return assertNever(object);
  }
}

function retargeted(object: CatalogObject, dependencies: readonly ObjectIdentity[]): CatalogObject {
  return { ...object, dependencies: dependencies.map((target) => ({ target })) };
}

function rewriteTable(
  object: TableObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): TableObject {
  const partition = object.definition.partition;
  const renamed =
    partition !== undefined &&
    object.identity.name === change.parent.name &&
    sameNamespace(object.identity.namespace, change.parent.namespace);
  return table({
    namespace: object.identity.namespace,
    name: object.identity.name,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(object.comment !== undefined ? { comment: object.comment } : {}),
    ...(object.definition.rowSecurity === undefined
      ? {}
      : { rowSecurity: object.definition.rowSecurity }),
    ...(partition === undefined
      ? {}
      : {
          partition: {
            ...partition,
            columns: renamed
              ? partition.columns.map((name) => (name === change.from ? change.to : name))
              : [...partition.columns],
          },
        }),
  });
}

function rewriteColumn(
  object: ColumnObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): ColumnObject {
  const renamed =
    sameRef(object.identity.parent, change.parent) && object.identity.name === change.from;
  const definition = object.definition;
  const local = sameRef(object.identity.parent, change.parent);
  return keepMark(
    object,
    column({
      parent: object.identity.parent,
      name: renamed ? change.to : object.identity.name,
      dataType: definition.dataType,
      nullable: definition.nullable,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(definition.defaultExpression !== undefined
        ? { defaultExpression: rewriteExpr(definition.defaultExpression, change, local) }
        : {}),
      ...(definition.collation !== undefined ? { collation: definition.collation } : {}),
      ...(definition.identity !== undefined ? { identity: definition.identity } : {}),
      ...(definition.generated !== undefined
        ? {
            generated: {
              stored: definition.generated.stored,
              expression: rewriteExpr(definition.generated.expression, change, local),
            },
          }
        : {}),
    }),
  );
}

function keepMark(from: ColumnObject, to: ColumnObject): ColumnObject {
  const mark = from.definition.unvalidatedNotNull;
  return mark === undefined ? to : withUnvalidatedNotNull(to, mark);
}

function rewriteIndex(
  object: IndexObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): IndexObject {
  const local = sameRef(object.identity.parent, change.parent);
  const definition = object.definition;
  return indexAgain(object, object.identity.parent, dependencies, {
    columns: local
      ? renameList(definition.columns, change.from, change.to)
      : [...definition.columns],
    ...(definition.predicate !== undefined
      ? { predicate: rewriteExpr(definition.predicate, change, local) }
      : {}),
    ...(definition.expression !== undefined
      ? { expression: rewriteExpr(definition.expression, change, local) }
      : {}),
    ...(definition.include !== undefined
      ? {
          include: local
            ? renameList(definition.include, change.from, change.to)
            : [...definition.include],
        }
      : {}),
    ...(definition.elements !== undefined
      ? {
          elements: definition.elements.map((element) =>
            !local || element.column === undefined
              ? element
              : {
                  ...element,
                  column: element.column === change.from ? change.to : element.column,
                },
          ),
        }
      : {}),
  });
}

function indexAgain(
  object: IndexObject,
  parent: ObjectRef,
  dependencies: readonly ObjectIdentity[],
  patch: {
    readonly columns: readonly string[];
    readonly predicate?: string;
    readonly expression?: string;
    readonly include?: readonly string[];
    readonly elements?: IndexObject["definition"]["elements"];
  },
): IndexObject {
  const onView = dependencies.some(
    (edge) => edge.kind === "view" || edge.kind === "materializedView",
  );
  if (onView) {
    return materializedViewIndex({
      parent,
      name: object.identity.name,
      nameKey: object.definition.nameKey,
      columns: patch.columns,
      unique: object.definition.unique,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(patch.predicate !== undefined ? { predicate: patch.predicate } : {}),
      ...(patch.expression !== undefined ? { expression: patch.expression } : {}),
      ...(object.definition.method !== undefined ? { method: object.definition.method } : {}),
      ...(patch.include !== undefined ? { include: patch.include } : {}),
      ...(patch.elements !== undefined ? { elements: patch.elements } : {}),
      ...(object.definition.storage !== undefined ? { storage: object.definition.storage } : {}),
      ...(object.definition.nullsNotDistinct === true ? { nullsNotDistinct: true } : {}),
      ...(object.comment !== undefined ? { comment: object.comment } : {}),
    });
  }
  return index({
    parent,
    name: object.identity.name,
    nameKey: object.definition.nameKey,
    columns: patch.columns,
    unique: object.definition.unique,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(patch.predicate !== undefined ? { predicate: patch.predicate } : {}),
    ...(patch.expression !== undefined ? { expression: patch.expression } : {}),
    ...(object.definition.method !== undefined ? { method: object.definition.method } : {}),
    ...(patch.include !== undefined ? { include: patch.include } : {}),
    ...(patch.elements !== undefined ? { elements: patch.elements } : {}),
    ...(object.definition.storage !== undefined ? { storage: object.definition.storage } : {}),
    ...(object.definition.nullsNotDistinct === true ? { nullsNotDistinct: true } : {}),
    ...(object.comment !== undefined ? { comment: object.comment } : {}),
  });
}

function rewriteConstraint(
  object: ConstraintObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): ConstraintObject {
  const definition = object.definition;
  const local = sameRef(object.identity.parent, change.parent);
  const references = definition.references;
  const referenced =
    references !== undefined && sameRef(references.parent, change.parent)
      ? {
          parent: references.parent,
          columns: renameList(references.columns, change.from, change.to),
          ...(references.onDelete !== undefined ? { onDelete: references.onDelete } : {}),
          ...(references.onUpdate !== undefined ? { onUpdate: references.onUpdate } : {}),
        }
      : references;
  const rewritten = constraint({
    parent: object.identity.parent,
    constraintKind: definition.constraintKind,
    name: object.identity.name,
    nameKey: definition.nameKey,
    columns: local
      ? renameList(definition.columns, change.from, change.to)
      : [...definition.columns],
    deferrable: definition.deferrable,
    initially: definition.initially,
    nullsNotDistinct: definition.nullsNotDistinct,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(definition.expression !== undefined
      ? { expression: rewriteExpr(definition.expression, change, local) }
      : {}),
    ...(referenced !== undefined ? { references: referenced } : {}),
  });
  return markEnforced(rewritten, definition.enforced);
}

function rewriteView(
  object: ViewObject | MaterializedViewObject,
  dependencies: readonly ObjectIdentity[],
  query: string,
): CatalogObject {
  const input = {
    namespace: object.identity.namespace,
    name: object.identity.name,
    columns: object.definition.columns,
    query,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  };
  if (object.kind === "materializedView") {
    return materializedViewObject({
      ...input,
      ...(object.definition.refresh !== undefined ? { refresh: object.definition.refresh } : {}),
      ...(object.definition.populate === "later" ? { populate: "later" as const } : {}),
      ...(object.definition.using !== undefined ? { using: object.definition.using } : {}),
      ...(object.definition.storage !== undefined ? { storage: object.definition.storage } : {}),
      ...(object.definition.tablespace !== undefined
        ? { tablespace: object.definition.tablespace }
        : {}),
    });
  }
  return viewObject({
    ...input,
    ...(object.definition.securityInvoker === true ? { securityInvoker: true as const } : {}),
    ...(object.definition.securityBarrier === true ? { securityBarrier: true as const } : {}),
    ...(object.definition.checkOption !== undefined
      ? { checkOption: object.definition.checkOption }
      : {}),
  });
}

function rewritePolicyColumn(
  object: CatalogObject & { readonly kind: "policy" },
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  const local = sameRef(object.identity.parent, change.parent);
  return policyObject({
    parent: object.identity.parent,
    name: object.identity.name,
    command: object.definition.command,
    expression: rewriteExpr(object.definition.expression, change, local),
    force: object.definition.force,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function rewriteExpr(
  text: string,
  change: { readonly from: string; readonly to: string },
  active: boolean,
): string {
  if (!active) return text;
  return replaceIdentifier(text, change.from, change.to);
}

function rewriteTableName(
  object: CatalogObject,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
  fromKey: string,
  toIdentity: ObjectIdentity,
  source: Catalog,
): CatalogObject {
  const dependencies = retarget(object.dependencies, fromKey, toIdentity, change);
  const named =
    object.kind === "table" &&
    object.identity.name === change.from &&
    sameNamespace(object.identity.namespace, change.namespace);
  if (object.kind === "table") {
    return table({
      namespace: object.identity.namespace,
      name: named ? change.to : object.identity.name,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.definition.partition === undefined
        ? {}
        : { partition: object.definition.partition }),
    });
  }
  if (object.kind === "column" || object.kind === "index" || object.kind === "constraint") {
    const parent = movedParent(object.identity.parent, change);
    const local = parent.name !== object.identity.parent.name;
    if (object.kind === "column") {
      return keepMark(
        object,
        column({
          parent,
          name: object.identity.name,
          dataType: object.definition.dataType,
          nullable: object.definition.nullable,
          owner: object.owner,
          provenance: object.provenance,
          dependencies,
          ...(object.definition.defaultExpression !== undefined
            ? {
                defaultExpression: rewriteExpr(
                  object.definition.defaultExpression,
                  { from: change.from, to: change.to },
                  local,
                ),
              }
            : {}),
          ...(object.definition.collation !== undefined
            ? { collation: object.definition.collation }
            : {}),
          ...(object.definition.identity !== undefined
            ? { identity: object.definition.identity }
            : {}),
          ...(object.definition.generated !== undefined
            ? { generated: object.definition.generated }
            : {}),
        }),
      );
    }
    if (object.kind === "index") {
      return indexAgain(object, parent, dependencies, {
        columns: [...object.definition.columns],
        ...(object.definition.predicate !== undefined
          ? {
              predicate: rewriteExpr(
                object.definition.predicate,
                { from: change.from, to: change.to },
                local,
              ),
            }
          : {}),
        ...(object.definition.expression !== undefined
          ? {
              expression: rewriteExpr(
                object.definition.expression,
                { from: change.from, to: change.to },
                local,
              ),
            }
          : {}),
      });
    }
    const references = object.definition.references;
    const referenced =
      references === undefined
        ? undefined
        : {
            parent: movedParent(references.parent, change),
            columns: [...references.columns],
            ...(references.onDelete !== undefined ? { onDelete: references.onDelete } : {}),
            ...(references.onUpdate !== undefined ? { onUpdate: references.onUpdate } : {}),
          };
    const moved = constraint({
      parent,
      constraintKind: object.definition.constraintKind,
      name: object.identity.name,
      nameKey: object.definition.nameKey,
      columns: [...object.definition.columns],
      deferrable: object.definition.deferrable,
      initially: object.definition.initially,
      nullsNotDistinct: object.definition.nullsNotDistinct,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.definition.expression !== undefined
        ? {
            expression: rewriteExpr(
              object.definition.expression,
              { from: change.from, to: change.to },
              local,
            ),
          }
        : {}),
      ...(referenced !== undefined ? { references: referenced } : {}),
    });
    return markEnforced(moved, object.definition.enforced);
  }
  if (object.kind === "sequence") return rewriteSequence(object, dependencies);
  if (object.kind === "type") return rewriteType(object, dependencies);
  if (object.kind === "extension") {
    return { ...object, dependencies: dependencies.map((target) => ({ target })) };
  }
  if (object.kind === "function") {
    return retargetFunction(object, dependencies, object.definition.body);
  }
  if (object.kind === "view" || object.kind === "materializedView") {
    const local = object.dependencies.some((edge) => {
      if (edge.target.kind === "table") {
        return (
          edge.target.name === change.from && sameNamespace(edge.target.namespace, change.namespace)
        );
      }
      if (edge.target.kind === "column") {
        return (
          edge.target.parent.name === change.from &&
          sameNamespace(edge.target.parent.namespace, change.namespace)
        );
      }
      return false;
    });
    return rewriteView(
      object,
      dependencies,
      rewriteExpr(object.definition.query, { from: change.from, to: change.to }, local),
    );
  }
  if (object.kind === "role" || object.kind === "defaultPrivilege") {
    return retargeted(object, dependencies);
  }
  if (object.kind === "grant") {
    return grantObject({
      role: object.identity.role,
      object: movedGrantRef(object.identity.object, change, source),
      privilege: object.identity.privilege,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
    });
  }
  if (object.kind === "trigger") {
    const parent = movedParent(object.identity.parent, change);
    return triggerObject({
      parent,
      name: object.identity.name,
      timing: object.definition.timing,
      events: object.definition.events,
      level: object.definition.level,
      calls: object.definition.calls,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.definition.updateOf !== undefined ? { updateOf: object.definition.updateOf } : {}),
      ...(object.definition.when !== undefined ? { when: object.definition.when } : {}),
      ...(object.definition.referencing !== undefined
        ? { referencing: object.definition.referencing }
        : {}),
    });
  }
  if (object.kind === "eventTrigger") {
    return { ...object, dependencies: dependencies.map((target) => ({ target })) };
  }
  if (object.kind === "policy") {
    const parent = movedParent(object.identity.parent, change);
    const local = parent.name !== object.identity.parent.name;
    return policyObject({
      parent,
      name: object.identity.name,
      command: object.definition.command,
      expression: rewriteExpr(
        object.definition.expression,
        { from: change.from, to: change.to },
        local,
      ),
      force: object.definition.force,
      ...(object.definition.restrictive === true ? { restrictive: true as const } : {}),
      ...(object.definition.roles !== undefined ? { roles: object.definition.roles } : {}),
      ...(object.definition.check !== undefined
        ? {
            check: rewriteExpr(
              object.definition.check,
              { from: change.from, to: change.to },
              local,
            ),
          }
        : {}),
      ...(object.definition.checkOnly === true ? { checkOnly: true as const } : {}),
      ...(object.definition.disabled === true ? { disabled: true as const } : {}),
      ...(object.comment !== undefined ? { comment: object.comment } : {}),
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
    });
  }
  return assertNever(object);
}

function movedParent(
  parent: ObjectRef,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
): ObjectRef {
  if (parent.name === change.from && sameNamespace(parent.namespace, change.namespace)) {
    return { namespace: parent.namespace, name: change.to };
  }
  return parent;
}

function rewriteType(
  object: CatalogObject & { readonly kind: "type" },
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (isDomain(object.definition)) {
    return domainType({
      namespace: object.identity.namespace,
      name: object.identity.name,
      base: object.definition.base,
      check: object.definition.check,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
    });
  }
  if (isComposite(object.definition)) {
    return compositeType({
      namespace: object.identity.namespace,
      name: object.identity.name,
      fields: object.definition.fields,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.comment !== undefined ? { comment: object.comment } : {}),
    });
  }
  if (isRange(object.definition)) {
    return rangeType({
      namespace: object.identity.namespace,
      name: object.identity.name,
      subtype: object.definition.subtype,
      multirange: object.definition.multirange,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.definition.subtypeDiff !== undefined
        ? { subtypeDiff: object.definition.subtypeDiff }
        : {}),
      ...(object.definition.collation !== undefined
        ? { collation: object.definition.collation }
        : {}),
      ...(object.comment !== undefined ? { comment: object.comment } : {}),
    });
  }
  return enumType({
    namespace: object.identity.namespace,
    name: object.identity.name,
    labels: object.definition.labels,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function rewriteSequence(
  object: SequenceObject,
  dependencies: readonly ObjectIdentity[],
): SequenceObject {
  return sequence({
    namespace: object.identity.namespace,
    name: object.identity.name,
    dataType: object.definition.dataType,
    start: object.definition.start,
    increment: object.definition.increment,
    cycle: object.definition.cycle,
    ...(object.definition.min !== undefined ? { min: object.definition.min } : {}),
    ...(object.definition.max !== undefined ? { max: object.definition.max } : {}),
    ...(object.definition.cache !== undefined ? { cache: object.definition.cache } : {}),
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function renameList(names: readonly string[], from: string, to: string): string[] {
  return names.map((name) => (name === from ? to : name));
}

function retarget(
  edges: readonly DependencyEdge[],
  fromKey: string,
  to: ObjectIdentity,
  change?: { readonly namespace: Namespace; readonly from: string; readonly to: string },
): ObjectIdentity[] {
  return edges.map((edge) => {
    if (identityKey(edge.target) === fromKey) return to;
    if (change === undefined) return edge.target;
    return movedChild(edge.target, change);
  });
}

function movedChild(
  target: ObjectIdentity,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
): ObjectIdentity {
  if (!("parent" in target)) return target;
  if (
    target.parent.name !== change.from ||
    !sameNamespace(target.parent.namespace, change.namespace)
  ) {
    return target;
  }
  return { ...target, parent: { namespace: target.parent.namespace, name: change.to } };
}

function movedGrantRef(
  object: GrantObjectRef,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
  source: Catalog,
): GrantObjectRef {
  if (
    object.kind === "table" &&
    object.name === change.from &&
    sameNamespace(object.namespace, change.namespace)
  ) {
    return { ...object, name: change.to };
  }
  if (object.kind !== "sequence") return object;
  const next = renamedIdentitySequence(source, change, object.name);
  if (next === undefined) return object;
  return { ...object, name: next };
}

function renamedIdentitySequence(
  source: Catalog,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
  sequenceName: string,
): string | undefined {
  for (const object of source.objects) {
    if (object.kind !== "column" || object.definition.identity === undefined) continue;
    if (
      object.identity.parent.name !== change.from ||
      !sameNamespace(object.identity.parent.namespace, change.namespace)
    ) {
      continue;
    }
    if (identitySequenceName(change.from, object.identity.name) !== sequenceName) continue;
    return identitySequenceName(change.to, object.identity.name);
  }
  return undefined;
}

function dependencyJson(edges: readonly DependencyEdge[]): Json[] {
  const indexed = edges.map((edge) => ({
    key: identityKey(edge.target),
    target: identityToJson(edge.target),
  }));
  indexed.sort((left, right) => compareText(left.key, right.key));
  return indexed.map((item) => ({ target: item.target }));
}

function objectToJson(object: CatalogObject): Json {
  const dependencies = dependencyJson(object.dependencies);
  return {
    ...(object.comment !== undefined ? { comment: object.comment } : {}),
    definition: definitionToJson(object),
    dependencies,
    identity: identityToJson(object.identity),
    kind: object.kind,
    owner: object.owner,
    // `source` stays off the document. A line number is not part of the hash.
    provenance: { name: object.provenance.name, origin: object.provenance.origin },
  };
}

function definitionToJson(object: CatalogObject): Json {
  switch (object.kind) {
    case "table": {
      const partition = object.definition.partition;
      const rowSecurity = object.definition.rowSecurity;
      if (partition === undefined && rowSecurity === undefined) return {};
      return {
        ...(partition === undefined ? {} : { partition: partitionJson(partition) }),
        ...(rowSecurity === undefined
          ? {}
          : { rowSecurity: { enable: rowSecurity.enable, force: rowSecurity.force } }),
      };
    }
    case "column": {
      const definition = object.definition;
      return {
        dataType: definition.dataType,
        nullable: definition.nullable,
        ...(definition.defaultExpression !== undefined
          ? { defaultExpression: definition.defaultExpression }
          : {}),
        ...(definition.collation !== undefined ? { collation: definition.collation } : {}),
        ...(definition.unvalidatedNotNull !== undefined
          ? { unvalidatedNotNull: definition.unvalidatedNotNull }
          : {}),
        ...(definition.identity !== undefined
          ? { identity: identityFields(definition.identity) }
          : {}),
        ...(definition.series !== undefined ? { series: definition.series } : {}),
        ...(definition.generated !== undefined
          ? {
              generated: {
                expression: definition.generated.expression,
                stored: definition.generated.stored,
              },
            }
          : {}),
      };
    }
    case "index": {
      const definition = object.definition;
      return {
        columns: definition.columns,
        nameKey: definition.nameKey,
        unique: definition.unique,
        ...(definition.elements !== undefined ? { elements: definition.elements } : {}),
        ...(definition.expression !== undefined ? { expression: definition.expression } : {}),
        ...(definition.include !== undefined ? { include: definition.include } : {}),
        ...(definition.method !== undefined ? { method: definition.method } : {}),
        ...(definition.nullsNotDistinct === true ? { nullsNotDistinct: true } : {}),
        ...(definition.predicate !== undefined ? { predicate: definition.predicate } : {}),
        ...(definition.storage !== undefined ? { storage: definition.storage } : {}),
      };
    }
    case "constraint": {
      const definition = object.definition;
      const references = definition.references;
      return {
        columns: definition.columns,
        constraintKind: definition.constraintKind,
        deferrable: definition.deferrable,
        initially: definition.initially,
        nameKey: definition.nameKey,
        nullsNotDistinct: definition.nullsNotDistinct,
        ...(definition.enforced === false ? { enforced: false } : {}),
        ...(definition.expression !== undefined ? { expression: definition.expression } : {}),
        ...(definition.exclusion !== undefined ? { exclusion: definition.exclusion } : {}),
        ...(definition.withoutOverlaps === true ? { withoutOverlaps: true } : {}),
        ...(definition.period === true ? { period: true } : {}),
        ...(references !== undefined
          ? {
              references: {
                columns: references.columns,
                ...(references.onDelete !== undefined ? { onDelete: references.onDelete } : {}),
                ...(references.onDeleteColumns !== undefined
                  ? { onDeleteColumns: references.onDeleteColumns }
                  : {}),
                ...(references.onUpdate !== undefined ? { onUpdate: references.onUpdate } : {}),
                ...(references.match === "full" ? { match: "full" } : {}),
                parent: {
                  name: references.parent.name,
                  namespace: namespaceToJson(references.parent.namespace),
                },
              },
            }
          : {}),
      };
    }
    case "sequence":
      return {
        cycle: object.definition.cycle,
        dataType: object.definition.dataType,
        increment: object.definition.increment,
        start: object.definition.start,
        ...sequenceBounds(
          object.definition.dataType,
          object.definition.increment,
          object.definition,
        ),
      };
    case "type":
      if (isDomain(object.definition)) {
        return { base: object.definition.base, check: object.definition.check };
      }
      if (isComposite(object.definition)) {
        return {
          fields: object.definition.fields.map((field) => ({
            dataType: field.dataType,
            name: field.name,
            nullable: field.nullable,
            ...(field.comment !== undefined ? { comment: field.comment } : {}),
          })),
        };
      }
      if (isRange(object.definition)) {
        return {
          subtype: object.definition.subtype,
          multirange: object.definition.multirange,
          ...(object.definition.subtypeDiff !== undefined
            ? { subtypeDiff: object.definition.subtypeDiff }
            : {}),
          ...(object.definition.collation !== undefined
            ? { collation: object.definition.collation }
            : {}),
        };
      }
      return { labels: object.definition.labels };
    case "extension": {
      const definition = object.definition;
      return {
        relocatable: definition.relocatable,
        schema: definition.schema,
        ...(definition.version !== undefined ? { version: definition.version } : {}),
      };
    }
    case "function": {
      const definition = object.definition;
      const procedure = definition.routine === "procedure";
      return {
        arguments: definition.arguments.map((argument) => ({
          name: argument.name,
          type: argument.type,
          ...(argument.mode !== undefined && argument.mode !== "in" ? { mode: argument.mode } : {}),
          ...(argument.default !== undefined ? { default: argument.default } : {}),
        })),
        body: definition.body,
        language: definition.language,
        ...(procedure ? { routine: "procedure" } : { returns: definition.returns }),
        security: definition.security,
        ...(procedure ? {} : { volatility: definition.volatility }),
        ...(definition.atomic === true ? { atomic: true } : {}),
        ...(definition.searchPath !== undefined ? { searchPath: definition.searchPath } : {}),
        ...(definition.commits === true ? { commits: true } : {}),
        ...(definition.raises !== undefined
          ? {
              raises: definition.raises.map((item) => ({ code: item.code, name: item.name })),
            }
          : {}),
      };
    }
    case "trigger": {
      const definition = object.definition;
      return {
        calls: {
          argTypes: [...definition.calls.argTypes],
          name: definition.calls.name,
          namespace: namespaceToJson(definition.calls.namespace),
        },
        events: [...definition.events],
        level: definition.level,
        timing: definition.timing,
        ...(definition.updateOf !== undefined ? { updateOf: [...definition.updateOf] } : {}),
        ...(definition.when !== undefined ? { when: definition.when } : {}),
        ...(definition.referencing !== undefined
          ? { referencing: { ...definition.referencing } }
          : {}),
      };
    }
    case "eventTrigger": {
      const definition = object.definition;
      return {
        calls: {
          argTypes: [...definition.calls.argTypes],
          name: definition.calls.name,
          namespace: namespaceToJson(definition.calls.namespace),
        },
        enabled: definition.enabled,
        event: definition.event,
        ...(definition.tags !== undefined ? { tags: [...definition.tags] } : {}),
      };
    }
    case "view":
      return {
        columns: object.definition.columns.map((column) => ({
          dataType: column.dataType,
          name: column.name,
          ...(column.comment !== undefined ? { comment: column.comment } : {}),
        })),
        query: object.definition.query,
        ...(object.definition.securityInvoker === true ? { securityInvoker: true } : {}),
        ...(object.definition.securityBarrier === true ? { securityBarrier: true } : {}),
        ...(object.definition.checkOption !== undefined
          ? { checkOption: object.definition.checkOption }
          : {}),
      };
    case "policy":
      return {
        command: object.definition.command,
        expression: object.definition.expression,
        force: object.definition.force,
        ...(object.definition.restrictive === true ? { restrictive: true } : {}),
        ...(object.definition.roles !== undefined ? { roles: [...object.definition.roles] } : {}),
        ...(object.definition.check !== undefined ? { check: object.definition.check } : {}),
        ...(object.definition.checkOnly === true ? { checkOnly: true } : {}),
        ...(object.definition.disabled === true ? { disabled: true } : {}),
      };
    case "materializedView":
      return {
        columns: object.definition.columns.map((column) => ({
          dataType: column.dataType,
          name: column.name,
          ...(column.comment !== undefined ? { comment: column.comment } : {}),
        })),
        query: object.definition.query,
        ...(object.definition.refresh !== undefined ? { refresh: object.definition.refresh } : {}),
        ...(object.definition.populate === "later" ? { populate: "later" as const } : {}),
        ...(object.definition.using !== undefined ? { using: object.definition.using } : {}),
        ...(object.definition.storage !== undefined
          ? { storage: object.definition.storage.map((pair) => [pair[0], pair[1]]) }
          : {}),
        ...(object.definition.tablespace !== undefined
          ? { tablespace: object.definition.tablespace }
          : {}),
      };
    case "role":
      return { inherit: object.definition.inherit, login: object.definition.login };
    case "grant":
    case "defaultPrivilege":
      return {};
    default:
      return assertNever(object);
  }
}

function parseObject(value: unknown): CatalogObject {
  const record = requireRecord(value, "catalog object");
  rejectUnknown(
    record,
    ["comment", "definition", "dependencies", "identity", "kind", "owner", "provenance"],
    "catalog object",
  );
  const kind = requireString(record.kind, "kind");
  if (kind === "policy") return parsePolicy(record);
  if (!isBuiltKind(kind)) {
    catalogError(
      "OKM1020",
      `Kind ${kind} is not built yet. Built kinds are ${BUILT_KINDS.join(", ")}.`,
    );
  }
  const identity = parseIdentity(record.identity);
  if (identity.kind !== kind) {
    catalogError("OKM1020", `${identityLabel(identity)} has kind ${kind}.`);
  }
  const owner = parseOwner(record.owner);
  const provenance = parseProvenance(record.provenance);
  const dependencies = parseDependencies(record.dependencies);
  const definition = requireRecord(record.definition, "definition");
  return withParsedComment(
    parseBuilt(kind, identity, definition, owner, provenance, dependencies),
    record.comment,
  );
}

function withParsedComment(object: CatalogObject, comment: unknown): CatalogObject {
  if (comment === undefined) return object;
  const text = requireString(comment, "comment");
  assertCommentText(text, "comment");
  return { ...object, comment: text };
}

function parseBuilt(
  kind: Exclude<CatalogObject["kind"], "policy">,
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  switch (kind) {
    case "table":
      return parseTable(identity, definition, owner, provenance, dependencies);
    case "column":
      return parseColumn(identity, definition, owner, provenance, dependencies);
    case "index":
      return parseIndex(identity, definition, owner, provenance, dependencies);
    case "constraint":
      return parseConstraint(identity, definition, owner, provenance, dependencies);
    case "sequence":
      return parseSequence(identity, definition, owner, provenance, dependencies);
    case "type":
      return parseType(identity, definition, owner, provenance, dependencies);
    case "extension":
      return parseExtension(identity, definition, owner, provenance, dependencies);
    case "function":
      return parseFunction(identity, definition, owner, provenance, dependencies);
    case "trigger":
      return parseTrigger(identity, definition, owner, provenance, dependencies);
    case "eventTrigger":
      return parseEventTrigger(identity, definition, owner, provenance, dependencies);
    case "view":
    case "materializedView":
      return parseView(kind, identity, definition, owner, provenance, dependencies);
    case "role":
      return parseRole(identity, definition, owner, provenance, dependencies);
    case "grant":
      return parseGrant(identity, definition, owner, provenance, dependencies);
    case "defaultPrivilege":
      return parseDefaultPrivilege(identity, definition, owner, provenance, dependencies);
    default:
      return assertNeverKind(kind);
  }
}

function parseTable(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "table") {
    catalogError("OKM1020", `Table object identity is ${identity.kind}, not a table.`);
  }
  rejectUnknown(definition, ["partition", "rowSecurity"], "table definition");
  const partition = definition.partition;
  return table({
    namespace: identity.namespace,
    name: identity.name,
    owner,
    provenance,
    dependencies,
    ...(partition === undefined ? {} : { partition: parsePartition(partition) }),
    ...(definition.rowSecurity === undefined
      ? {}
      : { rowSecurity: parseRowSecurity(definition.rowSecurity) }),
  });
}

function parseColumn(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "column") {
    catalogError("OKM1020", `Column object identity is ${identity.kind}, not a column.`);
  }
  rejectUnknown(
    definition,
    [
      "collation",
      "dataType",
      "defaultExpression",
      "generated",
      "identity",
      "nullable",
      "series",
      "unvalidatedNotNull",
    ],
    "column definition",
  );
  const generated = definition.generated;
  const columnIdentity = definition.identity;
  const mark = definition.unvalidatedNotNull;
  const built = column({
    parent: identity.parent,
    name: identity.name,
    dataType: requireString(definition.dataType, "data type"),
    nullable: requireBoolean(definition.nullable, "nullable"),
    owner,
    provenance,
    dependencies,
    ...(definition.defaultExpression === undefined
      ? {}
      : { defaultExpression: requireString(definition.defaultExpression, "default") }),
    ...(definition.collation === undefined
      ? {}
      : { collation: requireString(definition.collation, "collation") }),
    ...(columnIdentity === undefined ? {} : { identity: parseAlways(columnIdentity) }),
    ...(definition.series === undefined ? {} : { series: parseSeries(definition.series) }),
    ...(generated === undefined ? {} : { generated: parseGenerated(generated) }),
  });
  return mark === undefined
    ? built
    : withUnvalidatedNotNull(built, requireString(mark, "unvalidated NOT NULL"));
}

function parseIndexElements(value: unknown): readonly IndexElement[] {
  if (!Array.isArray(value)) catalogError("OKM1020", "Index elements must be a list.");
  return value.map((item) => {
    const record = requireRecord(item, "index element");
    rejectUnknown(record, ["column", "expression", "nulls", "opclass", "order"], "index element");
    const order =
      record.order === undefined ? undefined : requireString(record.order, "index order");
    if (order !== undefined && order !== "desc") {
      catalogError("OKM1020", `Index order ${order} must be desc.`);
    }
    const nulls =
      record.nulls === undefined ? undefined : requireString(record.nulls, "index nulls");
    if (nulls !== undefined && nulls !== "first" && nulls !== "last") {
      catalogError("OKM1020", `Index nulls ${nulls} must be first or last.`);
    }
    return {
      ...(record.column === undefined
        ? {}
        : { column: requireString(record.column, "index element column") }),
      ...(record.expression === undefined
        ? {}
        : { expression: requireString(record.expression, "index element expression") }),
      ...(order === undefined ? {} : { order }),
      ...(nulls === undefined ? {} : { nulls }),
      ...(record.opclass === undefined
        ? {}
        : { opclass: requireString(record.opclass, "index opclass") }),
    };
  });
}

function parseIndexStorage(value: unknown): Readonly<Record<string, string>> {
  const record = requireRecord(value, "index storage");
  const storage: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    storage[key] = requireString(record[key], "index storage");
  }
  return storage;
}

function parseIndex(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "index") {
    catalogError("OKM1020", `Index object identity is ${identity.kind}, not an index.`);
  }
  rejectUnknown(
    definition,
    [
      "columns",
      "elements",
      "expression",
      "include",
      "method",
      "nameKey",
      "nullsNotDistinct",
      "predicate",
      "storage",
      "unique",
    ],
    "index definition",
  );
  const shared = {
    parent: identity.parent,
    name: identity.name,
    nameKey: requireString(definition.nameKey, "name key"),
    columns: requireStrings(definition.columns, "index columns"),
    unique: requireBoolean(definition.unique, "unique"),
    owner,
    provenance,
    dependencies,
    ...(definition.predicate === undefined
      ? {}
      : { predicate: requireString(definition.predicate, "predicate") }),
    ...(definition.expression === undefined
      ? {}
      : { expression: requireString(definition.expression, "expression") }),
    ...(definition.method === undefined
      ? {}
      : { method: requireString(definition.method, "index method") }),
    ...(definition.include === undefined
      ? {}
      : { include: requireStrings(definition.include, "index include") }),
    ...(definition.elements === undefined
      ? {}
      : { elements: parseIndexElements(definition.elements) }),
    ...(definition.storage === undefined ? {} : { storage: parseIndexStorage(definition.storage) }),
    ...(definition.nullsNotDistinct === undefined
      ? {}
      : { nullsNotDistinct: requireBoolean(definition.nullsNotDistinct, "nulls not distinct") }),
  };
  const onView = dependencies.some(
    (edge) => edge.kind === "view" || edge.kind === "materializedView",
  );
  if (onView) return materializedViewIndex(shared);
  return index(shared);
}

function parseConstraint(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "constraint") {
    catalogError("OKM1020", `Constraint object identity is ${identity.kind}, not a constraint.`);
  }
  rejectUnknown(
    definition,
    [
      "columns",
      "constraintKind",
      "deferrable",
      "exclusion",
      "expression",
      "initially",
      "enforced",
      "nameKey",
      "nullsNotDistinct",
      "period",
      "references",
      "withoutOverlaps",
    ],
    "constraint definition",
  );
  const constraintKind = requireString(definition.constraintKind, "constraint kind");
  if (
    constraintKind !== "primaryKey" &&
    constraintKind !== "unique" &&
    constraintKind !== "foreignKey" &&
    constraintKind !== "check" &&
    constraintKind !== "exclusion"
  ) {
    catalogError(
      "OKM1020",
      `Constraint kind ${constraintKind} must be primaryKey, unique, foreignKey, check, or exclusion.`,
    );
  }
  const initially = requireString(definition.initially, "initially");
  if (initially !== "immediate" && initially !== "deferred") {
    catalogError("OKM1020", `Constraint initially ${initially} must be immediate or deferred.`);
  }
  const references = definition.references;
  const parsed = constraint({
    parent: identity.parent,
    constraintKind,
    name: identity.name,
    nameKey: requireString(definition.nameKey, "name key"),
    columns: requireStrings(definition.columns, "constraint columns"),
    deferrable: requireBoolean(definition.deferrable, "deferrable"),
    initially,
    nullsNotDistinct: requireBoolean(definition.nullsNotDistinct, "nulls not distinct"),
    owner,
    provenance,
    dependencies,
    ...(definition.expression === undefined
      ? {}
      : { expression: requireString(definition.expression, "expression") }),
    ...(definition.exclusion === undefined
      ? {}
      : { exclusion: parseExclusion(definition.exclusion) }),
    ...(definition.withoutOverlaps === true ? { withoutOverlaps: true as const } : {}),
    ...(definition.period === true ? { period: true as const } : {}),
    ...(references === undefined ? {} : { references: parseReferences(references) }),
  });
  return markEnforced(parsed, readEnforced(definition.enforced)?.enforced);
}

function parseExclusion(value: unknown): readonly {
  readonly column?: string;
  readonly expression?: string;
  readonly operator: "eq" | "overlaps" | "adjacent";
}[] {
  if (!Array.isArray(value) || value.length === 0) {
    catalogError("OKM1020", "Exclusion elements must be a non-empty list.");
  }
  return value.map((element) => {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      catalogError("OKM1020", "Exclusion element must be an object.");
    }
    const record = element as Record<string, unknown>;
    rejectUnknown(record, ["column", "expression", "operator"], "exclusion element");
    const operator = requireString(record.operator, "exclusion operator");
    if (operator !== "eq" && operator !== "overlaps" && operator !== "adjacent") {
      catalogError("OKM1020", `Exclusion operator ${operator} must be eq, overlaps, or adjacent.`);
    }
    return {
      operator,
      ...(record.column === undefined
        ? {}
        : { column: requireString(record.column, "exclusion column") }),
      ...(record.expression === undefined
        ? {}
        : { expression: requireString(record.expression, "exclusion expression") }),
    };
  });
}

function readEnforced(value: unknown): { readonly enforced: false } | undefined {
  if (value === undefined) return undefined;
  if (value === false) return { enforced: false };
  catalogError("OKM1020", "Constraint enforced must be false when it is set.");
}

function parseSequence(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "sequence") {
    catalogError("OKM1020", `Sequence object identity is ${identity.kind}, not a sequence.`);
  }
  rejectUnknown(
    definition,
    ["cache", "cycle", "dataType", "increment", "max", "min", "start"],
    "sequence definition",
  );
  const dataType = requireString(definition.dataType, "sequence type");
  if (dataType !== "smallint" && dataType !== "integer" && dataType !== "bigint") {
    catalogError("OKM1020", `Sequence type ${dataType} must be smallint, integer, or bigint.`);
  }
  return sequence({
    namespace: identity.namespace,
    name: identity.name,
    dataType,
    start: requireString(definition.start, "sequence start"),
    increment: requireString(definition.increment, "sequence increment"),
    cycle: requireBoolean(definition.cycle, "cycle"),
    ...(definition.min === undefined ? {} : { min: requireString(definition.min, "sequence min") }),
    ...(definition.max === undefined ? {} : { max: requireString(definition.max, "sequence max") }),
    ...(definition.cache === undefined
      ? {}
      : { cache: requireString(definition.cache, "sequence cache") }),
    owner,
    provenance,
    dependencies,
  });
}

function parseType(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "type") {
    catalogError("OKM1020", `Type object identity is ${identity.kind}, not a type.`);
  }
  if ("base" in definition || "check" in definition) {
    rejectUnknown(definition, ["base", "check"], "type definition");
    return domainType({
      namespace: identity.namespace,
      name: identity.name,
      base: requireString(definition.base, "domain base"),
      check: requireString(definition.check, "domain check"),
      owner,
      provenance,
      dependencies,
    });
  }
  if ("fields" in definition) {
    rejectUnknown(definition, ["fields"], "type definition");
    if (!Array.isArray(definition.fields)) {
      catalogError("OKM1020", `Composite ${identity.name} fields must be a list.`);
    }
    const fields = definition.fields.map((field) => {
      if (field === null || typeof field !== "object" || Array.isArray(field)) {
        catalogError("OKM1020", `Composite ${identity.name} field must be an object.`);
      }
      const record = field as Record<string, unknown>;
      rejectUnknown(record, ["comment", "dataType", "name", "nullable"], "composite field");
      const comment = record.comment;
      return {
        name: requireString(record.name, "composite field"),
        dataType: requireString(record.dataType, "composite field type"),
        nullable: requireBoolean(record.nullable, "composite field nullable"),
        ...(typeof comment === "string" ? { comment } : {}),
      };
    });
    return compositeType({
      namespace: identity.namespace,
      name: identity.name,
      fields,
      owner,
      provenance,
      dependencies,
    });
  }
  if ("subtype" in definition || "multirange" in definition) {
    rejectUnknown(
      definition,
      ["collation", "multirange", "subtype", "subtypeDiff"],
      "type definition",
    );
    return rangeType({
      namespace: identity.namespace,
      name: identity.name,
      subtype: requireString(definition.subtype, "range subtype"),
      multirange: requireString(definition.multirange, "range multirange"),
      owner,
      provenance,
      dependencies,
      ...(definition.subtypeDiff === undefined
        ? {}
        : { subtypeDiff: requireString(definition.subtypeDiff, "range subtype diff") }),
      ...(definition.collation === undefined
        ? {}
        : { collation: requireString(definition.collation, "range collation") }),
    });
  }
  rejectUnknown(definition, ["labels"], "type definition");
  return enumType({
    namespace: identity.namespace,
    name: identity.name,
    labels: requireStrings(definition.labels, "enum labels"),
    owner,
    provenance,
    dependencies,
  });
}

function parseFunction(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "function") {
    catalogError("OKM1020", `Function object identity is ${identity.kind}, not a function.`);
  }
  rejectUnknown(
    definition,
    [
      "arguments",
      "atomic",
      "body",
      "commits",
      "language",
      "raises",
      "returns",
      "routine",
      "ownedBy",
      "searchPath",
      "security",
      "volatility",
    ],
    "function definition",
  );
  const language = requireString(definition.language, "function language");
  if (language !== "sql" && language !== "plpgsql") {
    catalogError("OKM1020", `Function ${identity.name} language must be sql or plpgsql.`);
  }
  const procedure = definition.routine === "procedure";
  if (definition.routine !== undefined && !procedure) {
    catalogError("OKM1020", `Function ${identity.name} routine is not supported.`);
  }
  const volatility = parseVolatility(definition.volatility);
  const security = parseSecurity(definition.security);
  return functionObject({
    namespace: identity.namespace,
    name: identity.name,
    arguments: parseArguments(definition.arguments),
    returns: procedure ? "" : requireString(definition.returns, "function returns"),
    language,
    body: requireString(definition.body, "function body"),
    owner,
    provenance,
    dependencies,
    ...(procedure ? { routine: "procedure" as const } : {}),
    ...(volatility !== undefined ? { volatility } : {}),
    ...(security !== undefined ? { security } : {}),
    ...(definition.atomic === true ? { atomic: true } : {}),
    ...(definition.commits === true ? { commits: true } : {}),
    ...(definition.raises !== undefined ? { raises: parseRaises(definition.raises) } : {}),
    ...(definition.searchPath !== undefined
      ? { searchPath: requireString(definition.searchPath, "search path") }
      : {}),
    ...(definition.ownedBy !== undefined
      ? { ownedBy: requireString(definition.ownedBy, "function owner") }
      : {}),
  });
}

function parseArguments(value: unknown): {
  readonly name: string;
  readonly type: string;
  readonly mode?: "out" | "inout";
  readonly default?: string;
}[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) catalogError("OKM1020", "Function arguments must be an array.");
  return value.map((item) => {
    const record = requireRecord(item, "function argument");
    rejectUnknown(record, ["default", "mode", "name", "type"], "function argument");
    const mode = record.mode;
    if (mode !== undefined && mode !== "out" && mode !== "inout") {
      catalogError("OKM1020", "Argument mode is not supported.");
    }
    return {
      name: requireString(record.name, "argument name"),
      type: requireString(record.type, "argument type"),
      ...(mode === "out" || mode === "inout" ? { mode } : {}),
      ...(record.default !== undefined
        ? { default: requireString(record.default, "argument default") }
        : {}),
    };
  });
}

function parseRaises(value: unknown): { readonly name: string; readonly code: string }[] {
  if (!Array.isArray(value)) catalogError("OKM1020", "Function raises must be an array.");
  return value.map((item) => {
    const record = requireRecord(item, "function raise");
    rejectUnknown(record, ["code", "name"], "function raise");
    return {
      name: requireString(record.name, "raise name"),
      code: requireString(record.code, "raise code"),
    };
  });
}

function parseVolatility(value: unknown): "volatile" | "stable" | "immutable" | undefined {
  if (value === undefined) return undefined;
  const text = requireString(value, "volatility");
  if (text !== "volatile" && text !== "stable" && text !== "immutable") {
    catalogError("OKM1020", `Volatility ${text} is not supported.`);
  }
  return text;
}

function parseSecurity(value: unknown): "invoker" | "definer" | undefined {
  if (value === undefined) return undefined;
  const text = requireString(value, "security");
  if (text !== "invoker" && text !== "definer") {
    catalogError("OKM1020", `Security ${text} is not supported.`);
  }
  return text;
}

function parseTrigger(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "trigger") {
    catalogError("OKM1020", `Trigger object identity is ${identity.kind}, not a trigger.`);
  }
  rejectUnknown(
    definition,
    ["calls", "events", "level", "referencing", "timing", "updateOf", "when"],
    "trigger definition",
  );
  const timing = requireString(definition.timing, "trigger timing");
  if (timing !== "before" && timing !== "after" && timing !== "instead") {
    catalogError("OKM1020", `Trigger timing ${timing} is not supported.`);
  }
  const level = requireString(definition.level, "trigger level");
  if (level !== "row" && level !== "statement") {
    catalogError("OKM1020", `Trigger level ${level} is not supported.`);
  }
  const calls = requireRecord(definition.calls, "trigger call");
  rejectUnknown(calls, ["argTypes", "name", "namespace"], "trigger call");
  return triggerObject({
    parent: identity.parent,
    name: identity.name,
    timing,
    events: requireStrings(definition.events, "trigger events").map(parseEvent),
    level,
    calls: {
      namespace: parseNamespace(calls.namespace),
      name: requireString(calls.name, "trigger function"),
      argTypes: requireStrings(calls.argTypes, "trigger argument types"),
    },
    owner,
    provenance,
    dependencies,
    ...(definition.updateOf !== undefined
      ? { updateOf: requireStrings(definition.updateOf, "update of") }
      : {}),
    ...(definition.when !== undefined ? { when: requireString(definition.when, "when") } : {}),
    ...(definition.referencing !== undefined
      ? { referencing: parseReferencing(definition.referencing) }
      : {}),
  });
}

function parseReferencing(value: unknown): { readonly old?: string; readonly new?: string } {
  const record = requireRecord(value, "referencing");
  rejectUnknown(record, ["new", "old"], "referencing");
  const old = record.old === undefined ? undefined : requireString(record.old, "old table");
  const next = record.new === undefined ? undefined : requireString(record.new, "new table");
  return {
    ...(old !== undefined ? { old } : {}),
    ...(next !== undefined ? { new: next } : {}),
  };
}

function parseEventTrigger(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "eventTrigger") {
    catalogError("OKM1020", `Event trigger identity is ${identity.kind}.`);
  }
  rejectUnknown(definition, ["calls", "enabled", "event", "ownedBy", "tags"], "event trigger");
  const calls = requireRecord(definition.calls, "event trigger call");
  rejectUnknown(calls, ["argTypes", "name", "namespace"], "event trigger call");
  const event = requireString(definition.event, "event");
  if (
    event !== "ddl_command_start" &&
    event !== "ddl_command_end" &&
    event !== "sql_drop" &&
    event !== "table_rewrite"
  ) {
    catalogError("OKM1020", `Event ${event} is not supported.`);
  }
  const enabled =
    definition.enabled === undefined ? "origin" : requireString(definition.enabled, "enabled");
  if (
    enabled !== "origin" &&
    enabled !== "disabled" &&
    enabled !== "replica" &&
    enabled !== "always"
  ) {
    catalogError("OKM1020", `Event trigger enabled ${enabled} is not supported.`);
  }
  return eventTriggerObject({
    name: identity.name,
    event,
    enabled,
    calls: {
      namespace: parseNamespace(calls.namespace),
      name: requireString(calls.name, "event trigger function"),
      argTypes: requireStrings(calls.argTypes, "event trigger arguments"),
    },
    owner,
    provenance,
    dependencies,
    ...(definition.tags !== undefined
      ? { tags: requireStrings(definition.tags, "event trigger tags") }
      : {}),
    ...(definition.ownedBy !== undefined
      ? { ownedBy: requireString(definition.ownedBy, "event trigger owner") }
      : {}),
  });
}

function parseView(
  kind: "view" | "materializedView",
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== kind) {
    catalogError("OKM1020", `View object identity is ${identity.kind}, not a ${kind}.`);
  }
  const fields =
    kind === "view"
      ? ["columns", "query", "securityInvoker", "securityBarrier", "checkOption"]
      : ["columns", "query", "refresh", "populate", "using", "storage", "tablespace"];
  rejectUnknown(definition, fields, "view definition");
  const columns = parseViewColumns(definition.columns);
  const query = requireString(definition.query, "view query");
  const refresh = definition.refresh;
  if (refresh !== undefined && refresh !== "concurrently") {
    catalogError("OKM1020", `Materialized view ${identity.name} refresh is not supported.`);
  }
  const input = {
    namespace: identity.namespace,
    name: identity.name,
    columns,
    query,
    owner,
    provenance,
    dependencies,
  };
  if (kind === "materializedView") {
    return materializedViewObject({
      ...input,
      ...(refresh === "concurrently" ? { refresh: "concurrently" as const } : {}),
      ...parsePopulate(definition.populate, identity.name),
      ...parseUsing(definition.using, identity.name),
      ...parseStorage(definition.storage, identity.name),
      ...parseTablespace(definition.tablespace, identity.name),
    });
  }
  if (definition.securityInvoker !== undefined && definition.securityInvoker !== true) {
    catalogError("OKM1020", `View ${identity.name} securityInvoker must be true when set.`);
  }
  if (definition.securityBarrier !== undefined && definition.securityBarrier !== true) {
    catalogError("OKM1020", `View ${identity.name} securityBarrier must be true when set.`);
  }
  const checkOption = definition.checkOption;
  if (checkOption !== undefined && checkOption !== "local" && checkOption !== "cascaded") {
    catalogError("OKM1020", `View ${identity.name} checkOption must be local or cascaded.`);
  }
  return viewObject({
    ...input,
    ...(definition.securityInvoker === true ? { securityInvoker: true as const } : {}),
    ...(definition.securityBarrier === true ? { securityBarrier: true as const } : {}),
    ...(checkOption === "local" || checkOption === "cascaded" ? { checkOption } : {}),
  });
}

function parsePopulate(value: unknown, name: string): { readonly populate?: "later" } {
  if (value === undefined) return {};
  if (value !== "later")
    catalogError("OKM1020", `Materialized view ${name} populate must be later.`);
  return { populate: "later" };
}

function parseUsing(value: unknown, name: string): { readonly using?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.length === 0) {
    catalogError("OKM1020", `Materialized view ${name} using must be text.`);
  }
  return { using: value };
}

function parseStorage(
  value: unknown,
  name: string,
): { readonly storage?: readonly (readonly [string, string])[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value))
    catalogError("OKM1020", `Materialized view ${name} storage must be pairs.`);
  const storage = value.map((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    ) {
      catalogError("OKM1020", `Materialized view ${name} storage must be pairs of text.`);
    }
    return [pair[0], pair[1]] as const;
  });
  return { storage };
}

function parseTablespace(value: unknown, name: string): { readonly tablespace?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.length === 0) {
    catalogError("OKM1020", `Materialized view ${name} tablespace must be text.`);
  }
  return { tablespace: value };
}

function parsePolicy(record: Record<string, unknown>): CatalogObject {
  const identity = parseIdentity(record.identity);
  if (identity.kind !== "policy") {
    catalogError("OKM1020", `Policy object identity is ${identity.kind}, not a policy.`);
  }
  const owner = parseOwner(record.owner);
  const provenance = parseProvenance(record.provenance);
  const dependencies = parseDependencies(record.dependencies);
  const definition = requireRecord(record.definition, "definition");
  rejectUnknown(
    definition,
    ["check", "checkOnly", "command", "disabled", "expression", "force", "restrictive", "roles"],
    "policy definition",
  );
  const command = requireString(definition.command, "policy command");
  if (
    command !== "all" &&
    command !== "select" &&
    command !== "insert" &&
    command !== "update" &&
    command !== "delete"
  ) {
    catalogError("OKM1020", `Policy ${identity.name} command is not supported.`);
  }
  const roles = definition.roles;
  return withParsedComment(
    policyObject({
      parent: identity.parent,
      name: identity.name,
      command,
      expression: requireString(definition.expression, "policy expression"),
      force: requireBoolean(definition.force, "policy force"),
      ...(definition.restrictive === true ? { restrictive: true as const } : {}),
      ...(roles === undefined ? {} : { roles: requireStrings(roles, "policy roles") }),
      ...(definition.check === undefined
        ? {}
        : { check: requireString(definition.check, "policy check") }),
      ...(definition.checkOnly === true ? { checkOnly: true as const } : {}),
      ...(definition.disabled === true ? { disabled: true as const } : {}),
      owner,
      provenance,
      dependencies,
    }),
    record.comment,
  );
}

function parseRowSecurity(value: unknown): { readonly enable: boolean; readonly force: boolean } {
  const record = requireRecord(value, "row security");
  rejectUnknown(record, ["enable", "force"], "row security");
  return {
    enable: requireBoolean(record.enable, "row security enable"),
    force: requireBoolean(record.force, "row security force"),
  };
}

function parseViewColumns(value: unknown): { readonly name: string; readonly dataType: string }[] {
  if (!Array.isArray(value)) catalogError("OKM1020", "View columns must be a list.");
  return value.map((item) => {
    const record = requireRecord(item, "view column");
    rejectUnknown(record, ["comment", "dataType", "name"], "view column");
    return {
      name: requireString(record.name, "view column"),
      dataType: requireString(record.dataType, "view column type"),
      ...(record.comment === undefined
        ? {}
        : { comment: requireString(record.comment, "view column comment") }),
    };
  });
}

function parseEvent(value: string): "insert" | "update" | "delete" | "truncate" {
  if (value !== "insert" && value !== "update" && value !== "delete" && value !== "truncate") {
    catalogError("OKM1020", `Trigger event ${value} is not supported.`);
  }
  return value;
}

function parseExtension(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): ExtensionObject {
  if (identity.kind !== "extension") {
    catalogError("OKM1020", `Extension object identity is ${identity.kind}, not an extension.`);
  }
  rejectUnknown(definition, ["relocatable", "schema", "version"], "extension definition");
  return extensionObject({
    name: identity.name,
    schema: requireString(definition.schema, "extension schema"),
    relocatable: requireBoolean(definition.relocatable, "relocatable"),
    ...(definition.version !== undefined
      ? { version: requireString(definition.version, "extension version") }
      : {}),
    owner,
    provenance,
    dependencies,
  });
}

function parseIdentity(value: unknown): ObjectIdentity {
  const record = requireRecord(value, "identity");
  const kind = requireString(record.kind, "identity kind");
  switch (kind) {
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
    case "type":
      rejectUnknown(record, ["kind", "name", "namespace"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        namespace: parseNamespace(record.namespace),
      };
    case "column":
    case "index":
    case "constraint":
    case "trigger":
    case "policy":
      rejectUnknown(record, ["kind", "name", "parent"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        parent: parseRef(record.parent),
      };
    case "function":
      rejectUnknown(record, ["argTypes", "kind", "name", "namespace"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        namespace: parseNamespace(record.namespace),
        argTypes: requireStrings(record.argTypes, "argument types"),
      };
    case "grant":
      rejectUnknown(record, ["kind", "object", "privilege", "role"], "identity");
      return {
        kind,
        role: requireString(record.role, "role"),
        privilege: requireString(record.privilege, "privilege"),
        object: parseGrantObject(record.object),
      };
    case "defaultPrivilege":
      rejectUnknown(
        record,
        ["forRole", "grantee", "kind", "namespace", "objectKind", "privilege"],
        "identity",
      );
      return {
        kind,
        forRole: requireString(record.forRole, "forRole"),
        grantee: requireString(record.grantee, "grantee"),
        namespace: parseNamespace(record.namespace),
        objectKind: requireString(record.objectKind, "object kind"),
        privilege: requireString(record.privilege, "privilege"),
      };
    case "role":
    case "extension":
    case "eventTrigger":
      rejectUnknown(record, ["kind", "name"], "identity");
      return { kind, name: requireString(record.name, "name") };
    default:
      catalogError("OKM1020", `Identity kind ${kind} is not a catalog identity.`);
  }
}

function parseNamespace(value: unknown): Namespace {
  const record = requireRecord(value, "namespace");
  const form = requireString(record.form, "namespace form");
  if (form === "static") {
    rejectUnknown(record, ["form", "name"], "namespace");
    return staticNamespace(requireString(record.name, "namespace"));
  }
  if (form === "template") {
    rejectUnknown(record, ["form", "pattern"], "namespace");
    return templateNamespace(requireString(record.pattern, "namespace template"));
  }
  catalogError("OKM1020", `Namespace form ${form} must be static or template.`);
}

function parseRef(value: unknown): ObjectRef {
  const record = requireRecord(value, "parent");
  rejectUnknown(record, ["name", "namespace"], "parent");
  return {
    name: requireString(record.name, "parent name"),
    namespace: parseNamespace(record.namespace),
  };
}

function parseGrantObject(value: unknown): {
  readonly kind:
    | "table"
    | "view"
    | "materializedView"
    | "sequence"
    | "function"
    | "procedure"
    | "namespace";
  readonly namespace: Namespace;
  readonly name: string;
} {
  const record = requireRecord(value, "grant object");
  rejectUnknown(record, ["kind", "name", "namespace"], "grant object");
  const kind = requireString(record.kind, "grant object kind");
  if (
    kind !== "table" &&
    kind !== "view" &&
    kind !== "materializedView" &&
    kind !== "sequence" &&
    kind !== "function" &&
    kind !== "procedure" &&
    kind !== "namespace"
  ) {
    catalogError(
      "OKM1020",
      `Grant object kind ${kind} must be table, view, materializedView, sequence, function, procedure, or namespace.`,
    );
  }
  return {
    kind,
    name: requireString(record.name, "grant object name"),
    namespace: parseNamespace(record.namespace),
  };
}

function parseRole(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "role") {
    catalogError("OKM1020", `Role object identity is ${identity.kind}, not a role.`);
  }
  rejectUnknown(definition, ["inherit", "login"], "role definition");
  return roleObject({
    name: identity.name,
    login: requireBoolean(definition.login, "login"),
    inherit: requireBoolean(definition.inherit, "inherit"),
    owner,
    provenance,
    dependencies,
  });
}

function parseGrant(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "grant") {
    catalogError("OKM1020", `Grant object identity is ${identity.kind}, not a grant.`);
  }
  rejectUnknown(definition, [], "grant definition");
  return grantObject({
    role: identity.role,
    object: identity.object,
    privilege: identity.privilege,
    owner,
    provenance,
    dependencies,
  });
}

function parseDefaultPrivilege(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "defaultPrivilege") {
    catalogError(
      "OKM1020",
      `Default privilege object identity is ${identity.kind}, not a default privilege.`,
    );
  }
  rejectUnknown(definition, [], "default privilege definition");
  return defaultPrivilegeObject({
    forRole: identity.forRole,
    namespace: identity.namespace,
    objectKind: identity.objectKind,
    grantee: identity.grantee,
    privilege: identity.privilege,
    owner,
    provenance,
    dependencies,
  });
}

function partitionJson(partition: NonNullable<TableDefinition["partition"]>): Json {
  return {
    columns: [...partition.columns],
    method: partition.method,
    ...(partition.children !== undefined
      ? {
          children: partition.children.map((child) => ({
            bound: child.bound,
            suffix: child.suffix,
          })),
        }
      : {}),
    ...(partition.count !== undefined ? { count: partition.count } : {}),
    ...(partition.ownership !== undefined ? { ownership: partition.ownership } : {}),
    ...(partition.rule !== undefined ? { rule: partition.rule } : {}),
  };
}

function parsePartition(value: unknown): NonNullable<TableDefinition["partition"]> {
  const record = requireRecord(value, "partition");
  rejectUnknown(
    record,
    ["children", "columns", "count", "method", "ownership", "rule"],
    "partition",
  );
  const method = requireString(record.method, "partition method");
  if (method !== "range" && method !== "list" && method !== "hash") {
    catalogError("OKM1020", `Partition method ${method} must be range, list, or hash.`);
  }
  const ownership = record.ownership;
  if (ownership !== undefined && ownership !== "managed" && ownership !== "external") {
    catalogError("OKM1020", "Partition ownership must be managed or external.");
  }
  const count = record.count;
  if (count !== undefined && (typeof count !== "number" || !Number.isInteger(count))) {
    catalogError("OKM1020", "Partition count must be a whole number.");
  }
  return {
    method,
    columns: requireStrings(record.columns, "partition columns"),
    ...(ownership === "managed" || ownership === "external" ? { ownership } : {}),
    ...(typeof count === "number" ? { count } : {}),
    ...(record.rule !== undefined ? { rule: parseRule(record.rule) } : {}),
    ...(record.children !== undefined ? { children: parseChildren(record.children) } : {}),
  };
}

function parseRule(value: unknown): PartitionRule {
  const record = requireRecord(value, "partition rule");
  rejectUnknown(record, ["ahead", "at", "every", "from", "keepFor", "keepThen"], "partition rule");
  const keepThen = record.keepThen;
  if (keepThen !== undefined && keepThen !== "detach" && keepThen !== "drop") {
    catalogError("OKM1020", "Partition keepThen must be detach or drop.");
  }
  const ahead = record.ahead;
  if (typeof ahead !== "number") catalogError("OKM1020", "Partition ahead must be a number.");
  return {
    every: requireString(record.every, "partition every"),
    from: requireString(record.from, "partition from"),
    ahead,
    ...(record.at !== undefined ? { at: requireString(record.at, "partition at") } : {}),
    ...(record.keepFor !== undefined
      ? { keepFor: requireString(record.keepFor, "partition keepFor") }
      : {}),
    ...(keepThen === "detach" || keepThen === "drop" ? { keepThen } : {}),
  };
}

function parseChildren(
  value: unknown,
): NonNullable<NonNullable<TableDefinition["partition"]>["children"]> {
  if (!Array.isArray(value)) catalogError("OKM1020", "Partition children must be a list.");
  return value.map((item) => {
    const record = requireRecord(item, "partition child");
    rejectUnknown(record, ["bound", "suffix"], "partition child");
    return {
      suffix: requireString(record.suffix, "partition suffix"),
      bound: parseBoundRecord(record.bound),
    };
  });
}

function parseBoundRecord(value: unknown): PartitionBound {
  const record = requireRecord(value, "partition bound");
  const kind = requireString(record.kind, "partition bound kind");
  if (kind === "default") {
    rejectUnknown(record, ["kind"], "partition bound");
    return { kind: "default" };
  }
  if (kind === "hash") {
    rejectUnknown(record, ["kind", "modulus", "remainder"], "partition bound");
    const modulus = record.modulus;
    const remainder = record.remainder;
    if (typeof modulus !== "number" || typeof remainder !== "number") {
      catalogError("OKM1020", "Hash bound needs modulus and remainder.");
    }
    return { kind: "hash", modulus, remainder };
  }
  if (kind === "list") {
    rejectUnknown(record, ["kind", "values"], "partition bound");
    return { kind: "list", values: requireStrings(record.values, "partition values") };
  }
  if (kind === "range") {
    rejectUnknown(record, ["from", "kind", "to"], "partition bound");
    return {
      kind: "range",
      from: requireString(record.from, "partition from"),
      to: requireString(record.to, "partition to"),
    };
  }
  catalogError("OKM1020", `Partition bound kind ${kind} must be range, list, hash, or default.`);
}

function parseReferences(value: unknown): {
  readonly parent: ObjectRef;
  readonly columns: readonly string[];
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
} {
  const record = requireRecord(value, "references");
  rejectUnknown(
    record,
    ["columns", "match", "onDelete", "onDeleteColumns", "onUpdate", "parent"],
    "references",
  );
  const onDelete = parseAction(record.onDelete, "onDelete");
  const onUpdate = parseAction(record.onUpdate, "onUpdate");
  const match = record.match === undefined ? undefined : requireString(record.match, "match");
  if (match !== undefined && match !== "full") {
    catalogError("OKM1020", `Foreign key match ${match} is not full.`);
  }
  const onDeleteColumns =
    record.onDeleteColumns === undefined
      ? undefined
      : requireStrings(record.onDeleteColumns, "onDeleteColumns");
  return {
    parent: parseRef(record.parent),
    columns: requireStrings(record.columns, "referenced columns"),
    ...(onDelete !== undefined ? { onDelete } : {}),
    ...(onUpdate !== undefined ? { onUpdate } : {}),
    ...(match === "full" ? { match: "full" as const } : {}),
    ...(onDeleteColumns !== undefined ? { onDeleteColumns } : {}),
  };
}

function parseAction(value: unknown, role: string): ReferentialAction | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = requireString(value, role);
  const action = referentialAction(text);
  if (action === undefined) {
    catalogError(
      "OKM1020",
      `Referential action ${text} is not a catalog action. Accepted actions: cascade, no action, restrict, set default, set null.`,
    );
  }
  return action;
}

function parseAlways(value: unknown): {
  readonly always: boolean;
  readonly start?: string;
  readonly increment?: string;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
} {
  const record = requireRecord(value, "identity");
  rejectUnknown(
    record,
    ["always", "cache", "cycle", "increment", "max", "min", "start"],
    "identity",
  );
  return identityFields({
    always: requireBoolean(record.always, "always"),
    ...(record.start === undefined ? {} : { start: requireString(record.start, "identity start") }),
    ...(record.increment === undefined
      ? {}
      : { increment: requireString(record.increment, "identity increment") }),
    ...(record.min === undefined ? {} : { min: requireString(record.min, "identity min") }),
    ...(record.max === undefined ? {} : { max: requireString(record.max, "identity max") }),
    ...(record.cache === undefined ? {} : { cache: requireString(record.cache, "identity cache") }),
    ...(record.cycle === undefined
      ? {}
      : { cycle: requireBoolean(record.cycle, "identity cycle") }),
  });
}

function parseSeries(value: unknown): SeriesDefinition {
  const record = requireRecord(value, "series");
  rejectUnknown(
    record,
    [
      "as",
      "at",
      "by",
      "byType",
      "cache",
      "comment",
      "counter",
      "cycle",
      "increment",
      "max",
      "min",
      "moves",
      "name",
      "reset",
      "scope",
      "start",
      "when",
    ],
    "series",
  );
  const as = requireString(record.as, "series type");
  if (as !== "smallint" && as !== "integer" && as !== "bigint") {
    catalogError("OKM1020", `Series type ${as} must be smallint, integer, or bigint.`);
  }
  if (record.counter !== true) {
    catalogError("OKM1020", "Series counter must be true.");
  }
  const reset = record.reset;
  return {
    name: requireString(record.name, "series name"),
    as,
    start: requireString(record.start, "series start"),
    increment: requireString(record.increment, "series increment"),
    counter: true,
    ...(record.min === undefined ? {} : { min: requireString(record.min, "series min") }),
    ...(record.max === undefined ? {} : { max: requireString(record.max, "series max") }),
    ...(record.cache === undefined ? {} : { cache: requireString(record.cache, "series cache") }),
    ...(record.cycle === undefined ? {} : { cycle: requireBoolean(record.cycle, "series cycle") }),
    ...(reset === undefined ? {} : { reset: parseReset(reset) }),
    ...(record.at === undefined ? {} : { at: requireString(record.at, "series zone") }),
    ...(record.by === undefined ? {} : { by: requireString(record.by, "series by") }),
    ...(record.byType === undefined
      ? {}
      : { byType: requireString(record.byType, "series by type") }),
    ...(record.scope === undefined ? {} : { scope: parseScope(record.scope) }),
    ...(record.when === undefined ? {} : { when: requireString(record.when, "series when") }),
    ...(record.moves === undefined
      ? {}
      : { moves: record.moves === "renumber" ? "renumber" : refusedMoves(record.moves) }),
    ...(record.comment === undefined
      ? {}
      : { comment: requireString(record.comment, "series comment") }),
  };
}

function refusedMoves(value: unknown): "renumber" {
  catalogError("OKM1020", `Series moves ${String(value)} must be renumber.`);
}

function parseReset(value: unknown): SeriesReset {
  if (typeof value === "string") {
    if (
      value === "day" ||
      value === "week" ||
      value === "month" ||
      value === "quarter" ||
      value === "year"
    ) {
      return value;
    }
    catalogError("OKM1020", `Series reset ${value} must be day, week, month, quarter, or year.`);
  }
  const record = requireRecord(value, "series reset");
  const unit = requireString(record.unit, "series reset unit");
  if (
    unit !== "day" &&
    unit !== "week" &&
    unit !== "month" &&
    unit !== "quarter" &&
    unit !== "year"
  ) {
    catalogError(
      "OKM1020",
      `Series reset unit ${unit} must be day, week, month, quarter, or year.`,
    );
  }
  const every = record.every;
  if (typeof every !== "number" || !Number.isInteger(every) || every < 1) {
    catalogError("OKM1020", "Series reset every must be an integer of at least 1.");
  }
  return { every, unit, from: requireString(record.from, "series reset from") };
}

function parseScope(value: unknown): readonly { readonly name: string; readonly type: string }[] {
  if (!Array.isArray(value)) catalogError("OKM1020", "Series scope must be a list.");
  return value.map((item) => {
    const record = requireRecord(item, "series scope");
    return {
      name: requireString(record.name, "series scope name"),
      type: requireString(record.type, "series scope type"),
    };
  });
}

function parseGenerated(value: unknown): { readonly stored: boolean; readonly expression: string } {
  const record = requireRecord(value, "generated");
  rejectUnknown(record, ["expression", "stored"], "generated");
  return {
    stored: requireBoolean(record.stored, "stored"),
    expression: requireString(record.expression, "generated expression"),
  };
}

function parseOwner(value: unknown): Owner {
  const owner = requireString(value, "owner");
  if (!isOwner(owner)) {
    catalogError("OKM1020", `Owner ${owner} must be managed, external, or ignored.`);
  }
  return owner;
}

function parseProvenance(value: unknown): Provenance {
  const record = requireRecord(value, "provenance");
  rejectUnknown(record, ["name", "origin"], "provenance");
  const origin = requireString(record.origin, "provenance origin");
  const name = requireString(record.name, "provenance name");
  if (origin !== "file" && origin !== "trait" && origin !== "extension") {
    catalogError("OKM1020", `Provenance origin ${origin} must be file, trait, or extension.`);
  }
  return { origin, name };
}

function parseDependencies(value: unknown): readonly ObjectIdentity[] {
  if (!Array.isArray(value)) {
    catalogError("OKM1020", "Dependencies must be an array of targets.");
  }
  return value.map((item) => {
    const record = requireRecord(item, "dependency");
    rejectUnknown(record, ["target"], "dependency");
    return parseIdentity(record.target);
  });
}

function isBuiltKind(kind: string): kind is Exclude<CatalogObject["kind"], "policy"> {
  return (
    kind === "extension" ||
    kind === "function" ||
    kind === "trigger" ||
    kind === "eventTrigger" ||
    kind === "view" ||
    kind === "materializedView" ||
    kind === "role" ||
    kind === "grant" ||
    kind === "defaultPrivilege" ||
    (BUILT_KINDS as readonly string[]).includes(kind)
  );
}

function isOwner(value: string): value is Owner {
  return (OWNERS as readonly string[]).includes(value);
}

function requireRecord(value: unknown, role: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    catalogError("OKM1020", `${role} is not an object.`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, role: string): string {
  if (typeof value !== "string") {
    catalogError("OKM1020", `${role} is not a string.`);
  }
  return value;
}

function requireBoolean(value: unknown, role: string): boolean {
  if (typeof value !== "boolean") {
    catalogError("OKM1020", `${role} is not a boolean.`);
  }
  return value;
}

function requireStrings(value: unknown, role: string): readonly string[] {
  if (!Array.isArray(value)) {
    catalogError("OKM1020", `${role} is not an array.`);
  }
  return value.map((item) => requireString(item, role));
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  role: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      catalogError("OKM1020", `${role} has unexpected field ${key}.`);
    }
  }
}

function assertNever(value: never): never {
  return catalogError("OKM1020", `Unexpected catalog object ${JSON.stringify(value)}.`);
}

function assertNeverKind(value: never): never {
  return catalogError("OKM1020", `Unexpected kind ${JSON.stringify(value)}.`);
}
