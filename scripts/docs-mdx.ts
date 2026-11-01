/**
 * Convert handbook MDX into plain Markdown for the packed package docs.
 *
 * Reuses the same front-matter strip the site markdown twins use, then flattens
 * Callout / Tabs / Steps / Anatomy into agent-readable Markdown. No new MDX
 * components and no npm dependency.
 */

/** Site origin used when a handbook link has no packed twin. */
export const HANDBOOK_ORIGIN = "https://okm.omqkhafi.dev";

/**
 * Strip a leading YAML frontmatter block (`---` … `---`).
 *
 * Same behaviour as `site/lib/markdown-source.ts` `stripYamlFrontmatter`.
 *
 * @param raw - Full file contents
 * @returns Body after the closing `---` (leading blank line trimmed once)
 */
export function stripYamlFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return normalized;
  }
  return normalized.slice(end + "\n---\n".length).replace(/^\n/, "");
}

/**
 * Read the `title` field from MDX front matter.
 *
 * @param raw - Full file contents
 * @returns Title string, or undefined
 */
export function readMdxTitle(raw: string): string | undefined {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  const match = /^title:\s*(?:"([^"]*)"|'([^']*)'|(.+))$/m.exec(normalized.slice(4, end));
  const title = match?.[1] ?? match?.[2] ?? match?.[3];
  return title?.trim();
}

/**
 * Flatten MDX component tags into plain Markdown.
 *
 * @param body - MDX body without YAML front matter
 * @returns Plain Markdown
 */
export function mdxComponentsToMarkdown(body: string): string {
  let text = body.replace(/\r\n/g, "\n");
  text = flattenTabs(text);
  text = flattenSteps(text);
  text = flattenAnatomy(text);
  text = flattenCallouts(text);
  text = stripFenceTitles(text);
  text = stripCodeFocusMarkers(text);
  text = collapseBlankLines(text);
  return text.trim() + "\n";
}

/**
 * Convert one handbook MDX file into a packed Markdown body (no pack front matter).
 *
 * @param raw - Full MDX file
 * @returns `# Title` plus flattened body
 */
export function mdxToPackBody(raw: string): string {
  const title = readMdxTitle(raw) ?? "Documentation";
  let body = mdxComponentsToMarkdown(stripYamlFrontmatter(raw));
  body = stripSiteOnlyChrome(body);
  return `# ${title}\n\n${body}`;
}

/**
 * Drop handbook chrome that is useless or confusing offline.
 *
 * Removes "package copy on GitHub" lines and trailing `| Next |` nav tables.
 *
 * @param body - Flattened markdown
 */
export function stripSiteOnlyChrome(body: string): string {
  let text = body.replace(/^The package copy is .+\n+/gm, "");
  const nextAt = text.search(/\n\| Next \| You use it for \|\n\| --- \| --- \|\n/);
  if (nextAt !== -1) text = text.slice(0, nextAt + 1);
  return text.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Rewrite `/docs/...` handbook links for offline pack reading.
 *
 * Mapped pages become relative `.md` paths. Error anchors become
 * `errors/OKM####.md`. Unmapped handbook paths become one absolute handbook URL.
 *
 * @param markdown - Pack body that may still contain `/docs/...` links
 * @param fromPackRel - Pack path relative to `docs/`, such as `guide.md`
 * @param sitePathToPack - Map of handbook path (`/docs/a/b`) → pack file under `docs/`
 * @returns Rewritten markdown and leftover `/docs/` link targets (problems)
 */
export function rewriteHandbookLinks(
  markdown: string,
  fromPackRel: string,
  sitePathToPack: ReadonlyMap<string, string>,
): { readonly text: string; readonly unrewritten: readonly string[] } {
  const unrewritten: string[] = [];
  const seen = new Set<string>();
  const text = markdown.replace(LINK, (full, label: string, rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url.startsWith("/docs")) return full;
    const hashAt = url.indexOf("#");
    const pathPart = hashAt === -1 ? url : url.slice(0, hashAt);
    const hash = hashAt === -1 ? "" : url.slice(hashAt + 1);
    const handbookPath = normalizeDocsPath(pathPart);

    const errorCode = errorCodeFromDocsLink(handbookPath, hash);
    if (errorCode !== undefined) {
      const target = `errors/${errorCode}.md`;
      return `[${label}](${relativePackLink(fromPackRel, target)})`;
    }

    const packTarget = sitePathToPack.get(handbookPath);
    if (packTarget !== undefined) {
      const href =
        hash.length === 0
          ? relativePackLink(fromPackRel, packTarget)
          : `${relativePackLink(fromPackRel, packTarget)}#${hash}`;
      return `[${label}](${href})`;
    }

    if (!seen.has(url)) {
      seen.add(url);
      unrewritten.push(url);
    }
    return `[${label}](${HANDBOOK_ORIGIN}${url})`;
  });
  return { text, unrewritten };
}

/**
 * Collect OKM codes mentioned in markdown for pack front matter.
 *
 * @param text - Markdown body
 * @returns Sorted unique codes
 */
export function codesInText(text: string): readonly string[] {
  const codes = new Set<string>();
  for (const match of text.matchAll(/\bOKM\d{4}\b/g)) {
    if (match[0] !== undefined) codes.add(match[0]);
  }
  return [...codes].sort();
}

const LINK = /\[([^\]]*)\]\(\s*<?(\/docs[^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

function normalizeDocsPath(path: string): string {
  let value = path.split("?")[0] ?? path;
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (value === "/docs") return "/docs";
  return value;
}

function errorCodeFromDocsLink(path: string, hash: string): string | undefined {
  if (path === "/docs/reference/errors" || path === "/docs/operate/errors") {
    const fromHash = /^okm(\d{4})$/i.exec(hash);
    if (fromHash?.[1] !== undefined) return `OKM${fromHash[1]}`;
  }
  return undefined;
}

/**
 * Relative link from one pack file under `docs/` to another.
 *
 * @param fromRel - `guide.md` or `errors/OKM1.md`
 * @param toRel - Target under `docs/`
 */
export function relativePackLink(fromRel: string, toRel: string): string {
  const fromParts = fromRel.split("/");
  fromParts.pop();
  const toParts = toRel.split("/");
  const depth = fromParts.length;
  const prefix = depth === 0 ? "" : "../".repeat(depth);
  return `${prefix}${toParts.join("/")}`;
}

function flattenCallouts(text: string): string {
  return text.replace(
    /<Callout\b([^>]*)>([\s\S]*?)<\/Callout>/g,
    (_full, attrs: string, inner: string) => {
      const type = attr(attrs, "type") ?? "info";
      const title = attr(attrs, "title");
      const heading = title !== undefined ? title : type.charAt(0).toUpperCase() + type.slice(1);
      const body = inner.trim();
      if (body.length === 0) return `> **${heading}**\n`;
      const quoted = body
        .split("\n")
        .map((line) => (line.length === 0 ? ">" : `> ${line}`))
        .join("\n");
      return `> **${heading}**\n${quoted}\n`;
    },
  );
}

function flattenTabs(text: string): string {
  return text.replace(/<Tabs\b[^>]*>[\s\S]*?<\/Tabs>/g, (block) => {
    const parts: string[] = [];
    for (const match of block.matchAll(/<Tab\b([^>]*)>([\s\S]*?)<\/Tab>/g)) {
      const value = attr(match[1] ?? "", "value") ?? "Option";
      const inner = (match[2] ?? "").trim();
      parts.push(`### ${value}\n\n${inner}`);
    }
    return parts.join("\n\n");
  });
}

function flattenSteps(text: string): string {
  let out = text.replace(/<\/?Steps\b[^>]*>/g, "\n");
  out = out.replace(/<Step\b[^>]*>/g, "\n");
  out = out.replace(/<\/Step>/g, "\n");
  return out;
}

function flattenAnatomy(text: string): string {
  return text.replace(
    /<Anatomy\b([^>]*)>([\s\S]*?)<\/Anatomy>/g,
    (_full, attrs: string, inner: string) => {
      const call = attr(attrs, "call") ?? "call";
      const lines: string[] = [`\`${call}()\``, ""];
      for (const part of inner.matchAll(/<AnatomyPart\b([^>]*)>([\s\S]*?)<\/AnatomyPart>/g)) {
        const partAttrs = part[1] ?? "";
        const label = attr(partAttrs, "label") ?? attr(partAttrs, "slot") ?? "part";
        const code = attr(partAttrs, "code");
        const mark = attr(partAttrs, "mark");
        const body = stripAnatomyLines(part[2] ?? "").trim();
        const meta = [code, mark !== undefined ? `(${mark})` : undefined].filter(Boolean).join(" ");
        lines.push(`- **${label}**${meta.length > 0 ? `: \`${meta.replace(/`/g, "")}\`` : ""}`);
        if (body.length > 0) {
          for (const line of body.split("\n")) {
            lines.push(`  ${line}`);
          }
        }
      }
      return `${lines.join("\n")}\n`;
    },
  );
}

function stripAnatomyLines(inner: string): string {
  return inner
    .replace(/<AnatomyLine\b[^|]*?\/>/g, "")
    .replace(/<AnatomyLine\b[^>]*>[\s\S]*?<\/AnatomyLine>/g, "")
    .trim();
}

function stripFenceTitles(text: string): string {
  return text.replace(/^(\s*)```([^\n`]*)$/gm, (_full, indent: string, info: string) => {
    const language = info.trim().split(/\s+/)[0] ?? "";
    return `${indent}\`\`\`${language}`;
  });
}

function stripCodeFocusMarkers(text: string): string {
  return text.replace(/\s*\/\/\s*\[!code[^\]]*\]/g, "");
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function attr(attrs: string, name: string): string | undefined {
  const double = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  if (double?.[1] !== undefined) return double[1];
  const single = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(attrs);
  if (single?.[1] !== undefined) return single[1];
  const bare = new RegExp(`\\b${name}\\s*=\\s*\\{([^}]*)\\}`).exec(attrs);
  if (bare?.[1] !== undefined) {
    const inner = bare[1].trim();
    const str = /^["'](.*)["']$/.exec(inner);
    return str?.[1] ?? inner;
  }
  return undefined;
}
