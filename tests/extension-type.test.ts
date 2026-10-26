/**
 * Extension type spelling. `format_type` qualifies a type whose schema is
 * off the search path. The schema stores the unqualified name.
 */

import { expect, test } from "bun:test";

import { visibleExtensionType } from "../src/dialects/extension-type.js";

test("visibleExtensionType drops the install schema and keeps an array", () => {
  expect(visibleExtensionType("extensions.ltree", "extensions")).toBe("ltree");
  expect(visibleExtensionType("extensions.ltree[]", "extensions")).toBe("ltree[]");
  expect(visibleExtensionType("ltree", "extensions")).toBe("ltree");
  expect(visibleExtensionType('"My Ext".hstore', "My Ext")).toBe("hstore");
  expect(visibleExtensionType("public.citext", "extensions")).toBe("public.citext");
});
