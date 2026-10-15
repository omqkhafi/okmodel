/**
 * Browser source for `/webmcp.js`. The inline guard in the layout is what
 * decides whether a visitor downloads this.
 */

/** Tool registration script. Read-only handbook tools. */
export const WEBMCP_SCRIPT = `(() => {
  const mc =
    (typeof document !== "undefined" && document.modelContext) ||
    (typeof navigator !== "undefined" && navigator.modelContext);
  if (!mc || typeof mc.registerTool !== "function") return;

  const text = (value) => ({ content: [{ type: "text", text: value }] });

  mc.registerTool({
    name: "search_docs",
    description: "Search the OKModel handbook. Returns page URLs and excerpts.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to search for." } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
    async execute({ query }) {
      const url = "/api/search?query=" + encodeURIComponent(String(query ?? ""));
      const response = await fetch(url);
      const data = await response.json();
      const hits = Array.isArray(data) ? data.slice(0, 8) : [];
      const lines = hits.map((hit) => {
        const href = typeof hit.url === "string" ? hit.url : "";
        const excerpt = typeof hit.content === "string" ? hit.content.replace(/<[^>]+>/g, "") : "";
        return (href + " " + excerpt).trim();
      });
      return text(lines.length > 0 ? lines.join("\\n") : "No results");
    },
  });

  mc.registerTool({
    name: "get_page",
    description: "Fetch one handbook page as markdown. Pass the docs slug, such as reference/cli.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Handbook slug. Empty is the introduction." } },
      required: ["slug"],
    },
    annotations: { readOnlyHint: true },
    async execute({ slug }) {
      const path = markdownPath(slug);
      if (path === undefined) return text("Slug must be handbook path segments.");
      const response = await fetch(path);
      return text(await response.text());
    },
  });

  mc.registerTool({
    name: "list_pages",
    description: "List every handbook page title and its markdown URL.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async execute() {
      const response = await fetch("/llms.json");
      const data = await response.json();
      const pages = Array.isArray(data.pages) ? data.pages : [];
      const lines = pages.map((page) => {
        const title = typeof page.title === "string" ? page.title : "";
        const markdown = typeof page.markdown === "string" ? page.markdown : "";
        return (title + " " + markdown).trim();
      });
      return text(lines.join("\\n"));
    },
  });

  function markdownPath(slug) {
    const raw = String(slug ?? "").trim().replace(/^\\/docs\\//, "").replace(/\\.md$/, "");
    if (raw.length === 0 || raw === "index") return "/llms.mdx/docs/index.md";
    if (!/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(raw)) return undefined;
    const parts = raw.split("/");
    const last = parts.at(-1);
    return "/llms.mdx/docs/" + parts.slice(0, -1).concat(last + ".md").join("/");
  }
})();
`;
