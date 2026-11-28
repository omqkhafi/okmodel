/**
 * Expand support tags in handbook markdown.
 *
 * The rendered page uses the components in `site/components/support-phrase.tsx`.
 * Agent and llms routes read the MDX source, so the same tags become the
 * generated sentences here.
 */

import { FLOOR_PHRASE, SUPPORT_PHRASE, TAGLINE } from "./generated/docs-constants";

const TAGS: readonly (readonly [string, string])[] = [
  ["<Tagline />", TAGLINE],
  ["<SupportPhrase />", SUPPORT_PHRASE],
  ["<FloorPhrase />", FLOOR_PHRASE],
];

/**
 * Replace support tags with the generated sentences.
 *
 * @param markdown - Page body
 * @returns The body agents and llms routes serve
 */
export function expandSupportMarkers(markdown: string): string {
  let out = markdown;
  for (const [tag, phrase] of TAGS) out = out.replaceAll(tag, phrase);
  return out;
}
