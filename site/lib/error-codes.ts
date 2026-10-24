/**
 * Code index for the Errors handbook page. Rows come from `ERROR_DOCS`
 * (the same registry `bun run docs:errors` writes). Kind follows the
 * constructor default, plus the four codes that pass another kind.
 */

import { ERROR_DOCS } from "../../src/tooling/errors/registry.js";
import { githubBlobUrl } from "./shared";

/** One row in the generated code index. */
export type ErrorCodeRow = {
  readonly code: string;
  readonly kind: string;
  readonly summary: string;
  readonly anchor: string;
  readonly docsUrl: string;
};

/** Anchor id for a registry code (`OKM1860` → `okm1860`). */
export function errorCodeAnchor(code: string): string {
  return code.toLowerCase();
}

/**
 * Kind shown for a registry code on the handbook index.
 *
 * @param code - Spec code
 */
export function registryKind(code: string): string {
  switch (code) {
    case "OKM1401":
      return "outcome_unknown";
    case "OKM1846":
      return "timeout";
    case "OKM1520":
      return "schema_drift";
    case "OKM1522":
      return "conflict";
    case "OKM1825":
    case "OKM1850":
    case "OKM1851":
      return "forbidden";
    default:
      return "invalid";
  }
}

/** Every registry code as an index row, in registry order. */
export function errorCodeRows(): readonly ErrorCodeRow[] {
  return ERROR_DOCS.map((doc) => ({
    code: doc.code,
    kind: registryKind(doc.code),
    summary: doc.summary,
    anchor: errorCodeAnchor(doc.code),
    docsUrl: githubBlobUrl(`docs/errors/${doc.code}.md`),
  }));
}

/** Markers the generator rewrites inside `reference/errors.mdx`. */
export const ERROR_CODE_INDEX_BEGIN = "{/* BEGIN:error-code-index */}";
export const ERROR_CODE_INDEX_END = "{/* END:error-code-index */}";

/**
 * Markdown table for the Errors page registry section.
 *
 * @param rows - Index rows
 */
export function renderErrorCodeIndexMarkdown(
  rows: readonly ErrorCodeRow[] = errorCodeRows(),
): string {
  const lines: string[] = [
    "| Code | Kind | Summary | Docs |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const codeCell = `<a id="${row.anchor}" />[\`${row.code}\`](#${row.anchor})`;
    const summary = escapeMdxProse(row.summary);
    lines.push(
      `| ${codeCell} | \`${row.kind}\` | ${summary} | [${row.code}.md](${row.docsUrl}) |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Replace the generated block between markers, or throw when markers are missing.
 *
 * @param source - Full MDX file
 * @param body - Markdown to place between the markers
 */
export function withErrorCodeIndex(source: string, body: string): string {
  const start = source.indexOf(ERROR_CODE_INDEX_BEGIN);
  const end = source.indexOf(ERROR_CODE_INDEX_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error("errors.mdx is missing the error-code-index markers");
  }
  const before = source.slice(0, start + ERROR_CODE_INDEX_BEGIN.length);
  const after = source.slice(end);
  return `${before}\n${body.trimEnd()}\n${after}`;
}

/**
 * Whether a page body matches the current registry table.
 *
 * @param source - Full MDX file
 */
export function errorCodeIndexMatches(source: string): boolean {
  return source === withErrorCodeIndex(source, renderErrorCodeIndexMarkdown());
}

/**
 * Escape table-cell prose so MDX does not treat `{…}` as an expression or `|` as a column.
 *
 * @param text - Registry summary
 */
function escapeMdxProse(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}
