/**
 * `citext` as an extension column.
 *
 * This file is the only place that mentions the citext brand. Core accepts it
 * because {@link defineColumn} is generic.
 */

import { type ColumnBuilder, type PlainFlags, defineColumn } from "../column.js";
import { type Extension, extension } from "../schema.js";

/** Case-insensitive text contributed by the citext extension. */
export type Citext = string & { readonly "~citext": true };

/**
 * A citext column.
 *
 * @returns A builder whose row value is {@link Citext}
 */
export function citext(): ColumnBuilder<Citext, PlainFlags, undefined> {
  return defineColumn<Citext, PlainFlags>();
}

/**
 * Extension definition that contributes {@link Citext}.
 *
 * @returns The citext extension
 */
export function citextExtension(): Extension<"citext", { readonly citext: Citext }> {
  return extension<"citext", { readonly citext: Citext }>();
}
