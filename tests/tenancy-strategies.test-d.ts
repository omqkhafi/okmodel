/**
 * Composite `for()` requires every key. A path table has no tenant column.
 */

import { expectTypeOf } from "expect-type";

import type { Connected } from "../src/runtime/types.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { compositeApp, pathApp } from "./tenancy-strategies-schema.js";

expectTypeOf<keyof (typeof compositeApp)["~byName"]["documents"]["~row"]>().toEqualTypeOf<
  "id" | "title" | "body" | "organizationId" | "workspaceId"
>();

expectTypeOf<keyof (typeof compositeApp)["~byName"]["documents"]["~insert"]>().toEqualTypeOf<
  "id" | "title" | "body"
>();

expectTypeOf<keyof (typeof pathApp)["~byName"]["projects"]["~row"]>().toEqualTypeOf<
  "id" | "name" | "organizationId"
>();

expectTypeOf<keyof (typeof pathApp)["~byName"]["notes"]["~row"]>().toEqualTypeOf<
  "id" | "body" | "teamId"
>();

// @ts-expect-error columnTenancy() takes one key. Use compositeTenancy().
columnTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" });

type Composite = Connected<typeof compositeApp>;

const composite = null as unknown as Composite;
composite.for({ organizationId: "", workspaceId: "" });
// @ts-expect-error missing workspaceId
composite.for({ organizationId: "" });
// @ts-expect-error extra key
composite.for({ organizationId: "", workspaceId: "", extra: "" });

type Path = Connected<typeof pathApp>;
const paths = null as unknown as Path;
paths.for({ tenantId: "" });
// @ts-expect-error the path schema has one key
paths.for({ tenantId: "", organizationId: "" });
