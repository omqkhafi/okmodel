import { renderErrorCodeMarkdown } from "@/lib/error-code-markdown";
import { markdownResponse } from "@/lib/markdown-response";
import { markdownNotFoundResponse } from "@/lib/not-found-markdown";

export const revalidate = false;

/**
 * One registry code as markdown.
 *
 * The proxy rewrites `/docs/reference/errors/<CODE>.md`, and the extensionless
 * path when `Accept` prefers markdown. The code is a path segment because a
 * query string on that rewrite does not reach this handler. An unknown code
 * is a 404 with the same suggestions as any other missing handbook path.
 *
 * @param _request - Unused. The code is the route param.
 * @param context - `code` is `OKM####`
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await context.params;
  const normalized = normalizeCode(code);
  const path = `/docs/reference/errors/${normalized ?? code}.md`;
  if (normalized === undefined) return markdownNotFoundResponse(path);
  const body = renderErrorCodeMarkdown(normalized);
  if (body === undefined) return markdownNotFoundResponse(path);
  return markdownResponse(body);
}

/**
 * `OKM` plus four digits, or `undefined` when the segment is not a code.
 *
 * @param code - Route segment
 */
function normalizeCode(code: string): string | undefined {
  if (!/^okm\d{4}$/i.test(code)) return undefined;
  return `OKM${code.slice(3)}`;
}
