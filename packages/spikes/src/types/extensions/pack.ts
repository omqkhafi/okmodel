/**
 * Ten extension columns.
 *
 * Each brand is a distinct string. Core is unchanged: every builder is
 * {@link defineColumn} plus {@link extension}.
 */

import { type ColumnBuilder, type PlainFlags, defineColumn } from "../column.js";
import { type Extension, extension } from "../schema.js";

/**
 * String branded with an extension name.
 *
 * @typeParam TName - Extension name
 */
export type ExtBrand<TName extends string> = string & { readonly "~ext": TName };

/**
 * Column builder for one extension brand.
 *
 * @typeParam TName - Extension name
 * @returns A branded string column
 */
export function extColumn<TName extends string>(): ColumnBuilder<
  ExtBrand<TName>,
  PlainFlags,
  undefined
> {
  return defineColumn<ExtBrand<TName>, PlainFlags>();
}

/** citext column from the ten-extension pack. */
export const packCitext = extColumn<"citext">;

/** ltree column. */
export const packLtree = extColumn<"ltree">;

/** vector column. */
export const packVector = extColumn<"vector">;

/** hstore column. */
export const packHstore = extColumn<"hstore">;

/** cube column. */
export const packCube = extColumn<"cube">;

/** isn column. */
export const packIsn = extColumn<"isn">;

/** seg column. */
export const packSeg = extColumn<"seg">;

/** lquery column. */
export const packLquery = extColumn<"lquery">;

/** earthdistance column. */
export const packEarth = extColumn<"earth">;

/** PostGIS point column. */
export const packPoint = extColumn<"point">;

/** Column builders in the pack, in a stable order. */
export const packColumns = [
  packCitext,
  packLtree,
  packVector,
  packHstore,
  packCube,
  packIsn,
  packSeg,
  packLquery,
  packEarth,
  packPoint,
] as const;

/**
 * One extension definition whose type map holds that extension's brand.
 *
 * @typeParam TName - Extension name
 * @returns The definition
 */
export function packExtension<TName extends string>(): Extension<
  TName,
  { readonly [K in TName]: ExtBrand<TName> }
> {
  return extension<TName, { readonly [K in TName]: ExtBrand<TName> }>();
}

/**
 * Ten extension definitions.
 *
 * @returns The pack, in the same order as {@link packColumns}
 */
export function packExtensions(): readonly [
  Extension<"citext", { readonly citext: ExtBrand<"citext"> }>,
  Extension<"ltree", { readonly ltree: ExtBrand<"ltree"> }>,
  Extension<"vector", { readonly vector: ExtBrand<"vector"> }>,
  Extension<"hstore", { readonly hstore: ExtBrand<"hstore"> }>,
  Extension<"cube", { readonly cube: ExtBrand<"cube"> }>,
  Extension<"isn", { readonly isn: ExtBrand<"isn"> }>,
  Extension<"seg", { readonly seg: ExtBrand<"seg"> }>,
  Extension<"lquery", { readonly lquery: ExtBrand<"lquery"> }>,
  Extension<"earth", { readonly earth: ExtBrand<"earth"> }>,
  Extension<"point", { readonly point: ExtBrand<"point"> }>,
] {
  return [
    packExtension<"citext">(),
    packExtension<"ltree">(),
    packExtension<"vector">(),
    packExtension<"hstore">(),
    packExtension<"cube">(),
    packExtension<"isn">(),
    packExtension<"seg">(),
    packExtension<"lquery">(),
    packExtension<"earth">(),
    packExtension<"point">(),
  ];
}
