import defaultMdxComponents from "@fumadocs/base-ui/mdx";
import type { MDXComponents } from "mdx/types";

/**
 * MDX component map. Handbook pages are markdown, so this is the Fumadocs
 * defaults plus the per-page link override.
 *
 * @param components - Extra overrides from the page renderer
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
  };
}
