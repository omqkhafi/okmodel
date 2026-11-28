import { buildLlmsCatalog } from "@/lib/agent-docs";

export const dynamic = "force-static";
export const revalidate = false;

export function GET(): Response {
  return Response.json(buildLlmsCatalog(), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
