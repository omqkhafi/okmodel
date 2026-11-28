import { buildLlmsTxt } from "@/lib/agent-docs";

export const dynamic = "force-static";
export const revalidate = false;

export function GET(): Response {
  return new Response(buildLlmsTxt(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
