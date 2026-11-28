/**
 * Support sentences from the generated constants.
 *
 * Handbook pages render these instead of typing a floor or a tested range.
 * The markdown routes expand the same tags in `site/lib/support-phrase.ts`.
 */

import type { ReactNode } from "react";

import { FLOOR_PHRASE, SUPPORT_PHRASE, TAGLINE } from "@/lib/generated/docs-constants";

/**
 * Engine floor and tested range.
 *
 * @returns The generated support sentence, without a final period
 */
export function SupportPhrase(): ReactNode {
  return SUPPORT_PHRASE;
}

/**
 * Engine floor, without the tested range.
 *
 * @returns The generated floor sentence
 */
export function FloorPhrase(): ReactNode {
  return FLOOR_PHRASE;
}

/**
 * Package tagline, including the support sentence.
 *
 * @returns The generated tagline
 */
export function Tagline(): ReactNode {
  return TAGLINE;
}
