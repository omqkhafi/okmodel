/**
 * Heading attribute for a support chip.
 *
 * MDX reads `{feature="key"}` as a JavaScript expression, so the page form
 * is the bracket equivalent `[feature="key"]` and `[engines="postgres"]`.
 * The remark plugin strips that suffix, passes it to the heading, and
 * inserts the plain support line so search indexes it. The markdown routes
 * insert the same line. A brace suffix is accepted when it is still text.
 */

import type { Heading, Paragraph, Root, Text } from "mdast";

import type { EngineRule } from "./feature-model";
import { DOCS_ONLY_POSTGRES, FEATURE_RULES } from "./generated/feature-rules";

/** Attributes a heading may carry. */
export type HeadingAttrs = {
  readonly feature?: string;
  readonly engines?: string;
};

const ATTR_BLOCK =
  '(?:\\{(?:feature|engines)="[^"]*"(?:[ \\t]+(?:feature|engines)="[^"]*")*\\}|\\[(?:feature|engines)="[^"]*"(?:[ \\t]+(?:feature|engines)="[^"]*")*\\])';

const HEADING_LINE = new RegExp(`^(#{1,6})[ \\t]+(.*?)\\s+(${ATTR_BLOCK})[ \\t]*$`);

/**
 * Read `feature` and `engines` from a bracket or brace suffix.
 *
 * @param block - The suffix, including brackets or braces
 * @returns The attributes, or undefined when the block names neither
 */
export function parseHeadingAttrs(block: string): HeadingAttrs | undefined {
  const wrapped =
    (block.startsWith("{") && block.endsWith("}")) ||
    (block.startsWith("[") && block.endsWith("]"));
  const inner = wrapped ? block.slice(1, -1) : block;
  const attrs: { feature?: string; engines?: string } = {};
  for (const match of inner.matchAll(/(feature|engines)="([^"]*)"/g)) {
    const name = match[1];
    const value = match[2];
    if (value === undefined || value.length === 0) continue;
    if (name === "feature") attrs.feature = value;
    if (name === "engines") attrs.engines = value;
  }
  if (attrs.feature === undefined && attrs.engines === undefined) return undefined;
  return attrs;
}

/**
 * Chip rule for a heading.
 *
 * A registry key wins. An engine with no key is the docs-only chip.
 *
 * @param attrs - Heading attributes
 * @returns The rule, or undefined when the key or engine is unknown
 */
export function chipForAttributes(attrs: HeadingAttrs): EngineRule | undefined {
  if (attrs.feature !== undefined) return FEATURE_RULES[attrs.feature];
  if (attrs.engines === "postgres") return DOCS_ONLY_POSTGRES;
  return undefined;
}

/**
 * Replace heading attributes with the plain support line.
 *
 * Fenced code is left alone. An unknown key stays in the heading so the
 * lint can name it.
 *
 * @param markdown - Page body
 * @returns The body agents and llms routes serve
 */
export function annotateFeatureMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      fence = !fence;
      out.push(line);
      continue;
    }
    if (!fence) {
      const match = HEADING_LINE.exec(line);
      const hashes = match?.[1];
      const title = match?.[2];
      const block = match?.[3];
      const attrs = block === undefined ? undefined : parseHeadingAttrs(block);
      const chip = attrs === undefined ? undefined : chipForAttributes(attrs);
      if (hashes !== undefined && title !== undefined && chip !== undefined) {
        out.push(`${hashes} ${title.trimEnd()}`, "", chip.line);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Remark plugin. Strips the attribute and inserts the plain line.
 *
 * @returns The transformer
 */
export function remarkFeatureMarks(): (tree: Root) => void {
  return (tree) => {
    const children = tree.children;
    for (let index = 0; index < children.length; index += 1) {
      const node = children[index];
      if (node?.type !== "heading") continue;
      const inserted = applyHeading(node);
      if (inserted === undefined) continue;
      children.splice(index + 1, 0, inserted);
      index += 1;
    }
  };
}

function applyHeading(heading: Heading): Paragraph | undefined {
  const last = heading.children.at(-1);
  if (last?.type !== "text") return undefined;
  const text = last as Text;
  const match = /\s+(\{[^}]+\}|\[[^\]]+\])\s*$/.exec(text.value);
  const block = match?.[1];
  const at = match?.index;
  if (block === undefined || at === undefined) return undefined;
  const attrs = parseHeadingAttrs(block);
  if (attrs === undefined) return undefined;
  const chip = chipForAttributes(attrs);
  if (chip === undefined) return undefined;
  text.value = text.value.slice(0, at).trimEnd();
  const props: Record<string, string> = { ...(heading.data?.hProperties as Record<string, string> | undefined) };
  if (attrs.feature !== undefined) props.feature = attrs.feature;
  if (attrs.engines !== undefined) props.engines = attrs.engines;
  heading.data = { ...heading.data, hProperties: props };
  const paragraph: Paragraph = {
    type: "paragraph",
    children: [{ type: "text", value: chip.line }],
  };
  return paragraph;
}
