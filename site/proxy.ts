/**
 * Request-time markdown negotiation. `output: "export"` cannot run this file,
 * so production is a Next.js server (Vercel) rather than a static `out/` tree.
 */

import { isChromeInspectorProbe } from "@/lib/chrome-inspector";
import { DISCOVERY_LINK, markdownAlternateLink } from "@/lib/discovery-links";
import { isDocsRedirect } from "@/lib/docs-redirects";
import { errorCodeRewrite } from "@/lib/error-code-path";
import { docsPageExists } from "@/lib/handbook-pages";
import { markdownNegotiation, markdownTwinPath } from "@/lib/markdown-negotiate";
import { buildRobotsTxt } from "@/lib/robots-txt";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";
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

  const code = errorCodeRewrite(request.nextUrl.pathname, isMarkdownPreferred(request));
  if (code !== undefined) {
    const url = request.nextUrl.clone();
    // A query string on a proxy rewrite does not reach the route handler.
    url.pathname = `/api/error-code/${code}`;
    url.search = "";
    const response = NextResponse.rewrite(url);
    response.headers.set("Vary", "Accept");
    return response;
  }

  const action = markdownNegotiation(request);
  if (action.kind === "not-found") {
    const url = request.nextUrl.clone();
    url.pathname = "/api/markdown-not-found";
    url.searchParams.set("path", request.nextUrl.pathname);
    return NextResponse.rewrite(url);
  }

  if (action.kind === "pass" && !isServedHtmlPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/missing${request.nextUrl.pathname}`;
    url.search = "";
    return NextResponse.rewrite(url);
  }

  if (action.kind === "pass") return passThrough(request);

  const url = request.nextUrl.clone();
  url.pathname = action.pathname;
  const response = NextResponse.rewrite(url);
  response.headers.set("Vary", "Accept");
  stampAlternate(response, request.nextUrl.pathname);
  return response;
}

/**
 * Paths the App Router serves as HTML. Anything else is rewritten to the
 * suggestion 404. `/docs` is checked against the bundled page list.
 *
 * @param pathname - Request pathname
 */
function isServedHtmlPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (
    path === "/" ||
    path === "/search" ||
    path === "/changelog" ||
    path === "/sitemap.xml" ||
    path === "/robots.txt" ||
    path === "/webmcp.js" ||
    path === "/icon.svg" ||
    path === "/favicon.ico" ||
    path === "/missing"
  ) {
    return true;
  }
  if (path.startsWith("/changelog/") || path.startsWith("/.well-known/") || path.startsWith("/missing")) return true;
  if (isDocsRedirect(path)) return true;
  if (path === "/docs" || path.startsWith("/docs/")) return docsPageExists(path);
  return false;
}

/**
 * Continue to the App Router.
 *
 * @param request - Incoming request
 */
function passThrough(request: NextRequest): NextResponse {
  const response = NextResponse.next();
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
