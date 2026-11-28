import { notFoundDocument } from "@/components/not-found/not-found-view";
import { suggestPages } from "@/lib/search-docs";

export const revalidate = false;

/**
 * HTML 404. The proxy rewrites an unknown path to `/missing` plus that path,
 * because a query string on a middleware rewrite does not reach this handler.
 *
 * @param _request - Unused. The path is the route params.
 * @param context - Catch-all segments
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const pathname = path === undefined || path.length === 0 ? "" : `/${path.join("/")}`;
  const suggestions = pathname.length > 0 ? suggestPages(pathname) : [];
  return new Response(notFoundDocument(pathname, suggestions), {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex",
    },
  });
}
