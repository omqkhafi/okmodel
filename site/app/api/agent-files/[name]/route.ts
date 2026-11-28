import { agentFile, agentFiles } from "@/lib/agent-docs";

export const dynamic = "force-static";
export const dynamicParams = false;
export const revalidate = false;

/**
 * One split agent file. `/llms-core.txt` rewrites here as `core`.
 * An unknown name, including the removed full dump, is a 404.
 *
 * @param _request - Unused. The name comes from the path.
 * @param context - Route params
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  const file = agentFile(`llms-${name}.txt`);
  if (file === undefined) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(file.body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

/**
 * Prerender every split file. Names are the slug between `llms-` and `.txt`.
 */
export function generateStaticParams(): { name: string }[] {
  return agentFiles().map((file) => ({
    name: file.name.slice("llms-".length, -".txt".length),
  }));
}
