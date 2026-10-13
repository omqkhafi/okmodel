import { TerminalSnippet } from "@/components/terminal-snippet";
import { installDriverForFence, translatePackageScript } from "@/lib/package-managers";
import { CodeBlock, Pre } from "@fumadocs/base-ui/components/codeblock";
import { Tab, Tabs } from "@fumadocs/base-ui/components/tabs";
import defaultMdxComponents from "@fumadocs/base-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { isValidElement, type ComponentProps, type ReactNode } from "react";

/**
 * MDX component map. `bun add` and `bunx` fences render as a terminal.
 * Every other fence keeps the Fumadocs code block. `Tabs` switches variants.
 *
 * @param components - Extra overrides from the page renderer
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    pre: DocsPre,
    Tab,
    Tabs,
    ...components,
  };
}

/**
 * Fence renderer. Package commands become the terminal; the rest stay highlighted.
 *
 * @param props - Compiled `pre` props
 */
function DocsPre({ children, title, ...props }: ComponentProps<"pre"> & { readonly title?: string }) {
  const source = fenceText(children);
  const commands = translatePackageScript(source);
  const driver = installDriverForFence(source, title);
  if (commands && driver) return <TerminalSnippet commands={commands} driver={driver} />;
  if (commands) return <TerminalSnippet commands={commands} />;
  return (
    <CodeBlock {...props} title={title}>
      <Pre>{children}</Pre>
    </CodeBlock>
  );
}

/**
 * Plain text of a highlighted fence. Shiki wraps each line in `span.line`.
 *
 * @param node - `pre` children
 */
function fenceText(node: ReactNode): string {
  const lines = lineTexts(node);
  if (lines.length > 0) return lines.join("\n");
  return textOf(node).trim();
}

/**
 * Text of each `span.line`, in order.
 *
 * @param node - React node
 */
function lineTexts(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(lineTexts);
  if (!isValidElement(node)) return [];
  const props = node.props as { className?: unknown; children?: ReactNode };
  const className = typeof props.className === "string" ? props.className : "";
  if (className.split(/\s+/).includes("line")) return [textOf(props.children)];
  return lineTexts(props.children);
}

/**
 * Concatenated text under a node.
 *
 * @param node - React node
 */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement(node)) return "";
  const props = node.props as { children?: ReactNode };
  return textOf(props.children);
}
