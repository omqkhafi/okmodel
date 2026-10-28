import { orderedHandbookUrls } from "@/lib/llms-index";
import { getLLMText, source } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  const byUrl = new Map(source.getPages().map((page) => [page.url, page]));
  const ordered = orderedHandbookUrls().flatMap((url) => {
    const page = byUrl.get(url);
    return page === undefined ? [] : [page];
  });
  const seen = new Set(ordered.map((page) => page.url));
  const rest = source.getPages().filter((page) => !seen.has(page.url));
  const scan = [...ordered, ...rest].map(getLLMText);
  const scanned = await Promise.all(scan);

  return new Response(scanned.join("\n\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}
