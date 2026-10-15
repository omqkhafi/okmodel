/**
 * `/webmcp.js`. The layout injects this only after `modelContext` is present.
 */

import { WEBMCP_SCRIPT } from "@/lib/webmcp-script";

export const revalidate = false;

/**
 * Tool script for browsers that implement WebMCP.
 */
export function GET(): Response {
  return new Response(WEBMCP_SCRIPT, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
