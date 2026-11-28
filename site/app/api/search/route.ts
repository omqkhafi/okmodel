import { searchResponse } from "@/lib/search-docs";

export const revalidate = false;

/**
 * Handbook search.
 *
 * `GET /api/search?query=OKM1101`
 *
 * The body is `{ query, results }`. Each result has `title`, `url`,
 * `markdown` (absolute `.md` URL), `summary`, `section`, and `chip`.
 */
export function GET(request: Request): Response {
  const query = new URL(request.url).searchParams.get("query") ?? "";
  return Response.json(searchResponse(query));
}
