/**
 * Schema qualification for planned statements.
 */

import { quoteIdent } from "../catalog/sql.js";
import {
  CatalogError,
  namespaceOf,
  type CatalogObject,
  type NamespaceName,
} from "../catalog/object.js";
import { type NamespaceBinding } from "../catalog/render.js";

/**
 * Concrete schema for a logical namespace.
 *
 * @param namespace - Logical namespace on the catalog object
 * @param bindings - Apply bindings
 * @returns The scratch schema name
 */
export function concreteSchema(
  namespace: NamespaceName,
  bindings: readonly NamespaceBinding[],
): string {
  const binding = bindings.find(
    (item) => item.logical.name === namespace.name && item.logical.template === namespace.template,
  );
  if (binding === undefined) throw new CatalogError(`No binding for namespace ${namespace.name}.`);
  if (!/^[a-z_][a-z0-9_]*$/.test(binding.concrete)) {
    throw new CatalogError(`Concrete schema ${binding.concrete} is not a plain identifier.`);
  }
  return binding.concrete;
}

/**
 * Schema-qualified identifier.
 *
 * @param object - Catalog object that has a namespace
 * @param name - Identifier to qualify
 * @param bindings - Apply bindings
 * @returns `"schema"."name"`
 */
export function qualifyObject(
  object: CatalogObject,
  name: string,
  bindings: readonly NamespaceBinding[],
): string {
  const namespace = namespaceOf(object.identity);
  if (namespace === undefined) {
    throw new CatalogError(`${object.identity.name} has no namespace.`);
  }
  return `${quoteIdent(concreteSchema(namespace, bindings))}.${quoteIdent(name)}`;
}
