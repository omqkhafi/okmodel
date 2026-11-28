import { markdownNotFoundResponse } from "@/lib/not-found-markdown";

export const revalidate = false;

/**
 * Markdown 404. The proxy rewrites an unknown path here when Accept
 * prefers markdown. Suggestions are the closest handbook paths.
 */
export function GET(request: Request): Response {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  return markdownNotFoundResponse(path);
}
