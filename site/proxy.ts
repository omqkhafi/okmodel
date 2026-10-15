/**
 * Request-time markdown negotiation. `output: "export"` cannot run this file,
 * so production is a Next.js server (Vercel) rather than a static `out/` tree.
 */

import { isChromeInspectorProbe } from "@/lib/chrome-inspector";
import { DISCOVERY_LINK, markdownAlternateLink } from "@/lib/discovery-links";
import { markdownNegotiation, markdownTwinPath } from "@/lib/markdown-negotiate";
import { markdownNotFoundResponse } from "@/lib/not-found-markdown";
import { buildRobotsTxt } from "@/lib/robots-txt";
import { type NextRequest, NextResponse } from "next/server";

/**
 * When Accept prefers markdown, rewrite handbook URLs to their twins and 404
 * unknown paths with a markdown body. Always stamp `Vary: Accept` on those
 * responses so caches key the representation they selected.
 *
 * Chrome / Cursor DevTools probe this origin as CDP (`GET /json/version`);
 * answer 204 so those probes never paint as handbook 404s.
 *
 * @param request - Incoming request
 */
export function proxy(request: NextRequest): NextResponse | Response {
  if (isChromeInspectorProbe(request.method, request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 204 });
  }

  if (request.nextUrl.pathname === "/robots.txt") {
    return new NextResponse(buildRobotsTxt(), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Link: DISCOVERY_LINK,
      },
    });
  }

  const action = markdownNegotiation(request);
  if (action.kind === "pass") {
    const response = NextResponse.next();
    stampAlternate(response, request.nextUrl.pathname);
    return response;
  }

  if (action.kind === "not-found") {
    const body = markdownNotFoundResponse();
    return new NextResponse(body.body, {
      status: 404,
      headers: body.headers,
    });
  }

  const url = request.nextUrl.clone();
  url.pathname = action.pathname;
  const response = NextResponse.rewrite(url);
  response.headers.set("Vary", "Accept");
  stampAlternate(response, request.nextUrl.pathname);
  return response;
}

/**
 * Advertise this URL's markdown twin. Site-wide discovery links are set in
 * `next.config.ts` so JSON routes get them too.
 *
 * @param response - Outgoing response
 * @param pathname - Request pathname
 */
function stampAlternate(response: NextResponse, pathname: string): void {
  response.headers.append("Link", DISCOVERY_LINK);
  const alternate = markdownAlternateLink(pathname);
  if (alternate === undefined) return;
  response.headers.append("Link", alternate);
  if (markdownTwinPath(pathname) !== undefined) response.headers.set("Vary", "Accept");
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|og/|llms|icon\\.svg|favicon.ico|.*\\.png$|.*\\.svg$|.*\\.woff2$).*)",
  ],
};
