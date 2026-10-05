import { expectTypeOf } from "expect-type";

import type {
  Catalog,
  CatalogEnvelope,
  CatalogObject,
  DefaultPrivilegeIdentity,
  DependencyEdge,
  FunctionIdentity,
  GrantIdentity,
  Namespace,
  ObjectKind,
  Owner,
  Provenance,
} from "../src/contracts/internal.js";

expectTypeOf<Owner>().toEqualTypeOf<"managed" | "external" | "ignored">();

expectTypeOf<Catalog["version"]>().toEqualTypeOf<1>();

expectTypeOf<CatalogObject["kind"]>().toEqualTypeOf<
  | "table"
  | "column"
  | "index"
  | "constraint"
  | "sequence"
  | "type"
  | "extension"
  | "function"
  | "trigger"
>();

expectTypeOf<ObjectKind>().toEqualTypeOf<
  | "table"
  | "column"
  | "index"
  | "constraint"
  | "sequence"
  | "view"
  | "materializedView"
  | "type"
  | "function"
  | "trigger"
  | "policy"
  | "extension"
  | "role"
  | "grant"
  | "defaultPrivilege"
>();

expectTypeOf<GrantIdentity>().toMatchTypeOf<{
  readonly kind: "grant";
  readonly role: string;
  readonly privilege: string;
}>();

expectTypeOf<GrantIdentity["object"]["kind"]>().toEqualTypeOf<"table" | "sequence" | "namespace">();

expectTypeOf<DefaultPrivilegeIdentity>().toMatchTypeOf<{
  readonly forRole: string;
  readonly namespace: Namespace;
  readonly objectKind: string;
  readonly grantee: string;
  readonly privilege: string;
}>();

expectTypeOf<FunctionIdentity["argTypes"]>().toEqualTypeOf<readonly string[]>();

type EnvelopeKind<T> = T extends {
  readonly kind: infer Kind;
  readonly identity: unknown;
  readonly owner: Owner;
  readonly definition: unknown;
  readonly dependencies: readonly DependencyEdge[];
  readonly provenance: Provenance;
}
  ? Kind
  : never;

expectTypeOf<EnvelopeKind<CatalogObject>>().toEqualTypeOf<CatalogObject["kind"]>();

type ViewEnvelope = CatalogEnvelope<
  "view",
  { readonly kind: "view"; readonly namespace: Namespace; readonly name: string },
  { readonly columns: readonly string[] }
>;

expectTypeOf<ViewEnvelope["kind"]>().toEqualTypeOf<"view">();
expectTypeOf<ViewEnvelope["owner"]>().toEqualTypeOf<Owner>();
expectTypeOf<ViewEnvelope["dependencies"]>().toEqualTypeOf<readonly DependencyEdge[]>();
