/**
 * Every registry code has a short markdown twin, and the Errors page `.md`
 * is an index whose links are those twins.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";

import { GET as errorCode } from "../app/api/error-code/[code]/route";
import { GET as missing } from "../app/missing/[[...path]]/route";
import { proxy } from "../proxy";
import { ERROR_DOCS } from "../../src/tooling/errors/registry.js";
import { renderPageMarkdown } from "./agent-docs";
import { ERROR_CODE_CHAR_LIMIT, ERROR_INDEX_CHAR_LIMIT, renderErrorCodeMarkdown } from "./error-code-markdown";
import { errorCodeBrowserRedirect, errorCodeHtmlUrl, errorCodeMarkdownUrl, errorCodeRewrite } from "./error-code-path";
import { ERROR_FIXES } from "./generated/error-fixes";
import { absoluteDocsUrl } from "./markdown-url";
import { siteRoot } from "./repo";
import { searchHandbook } from "./search-docs";

test("every registry code has a twin under 20,000 characters and the index links resolve", async () => {
  const index = renderPageMarkdown("/docs/reference/errors");
  expect(index.length).toBeLessThan(ERROR_INDEX_CHAR_LIMIT);
  expect(index.startsWith("Source: https://okm.omqkhafi.dev/docs/reference/errors\n")).toBe(true);
  console.log(`errors index chars ${String(index.length)}`);

  let largest = 0;
  for (const doc of ERROR_DOCS) {
    const row = ERROR_FIXES.find((item) => item.code === doc.code);
    if (row === undefined) throw new Error(`missing generated row ${doc.code}`);
    const href = absoluteDocsUrl(errorCodeMarkdownUrl(doc.code));
    expect(index, doc.code).toContain(`[\`${doc.code}\`](${href}) \`${row.kind}\`: ${row.summary}`);
    const body = renderErrorCodeMarkdown(doc.code);
    if (body === undefined) throw new Error(`missing twin ${doc.code}`);
    expect(body.length, doc.code).toBeLessThanOrEqual(ERROR_CODE_CHAR_LIMIT);
    expect(body.startsWith(`Source: https://okm.omqkhafi.dev/docs/reference/errors/${doc.code}\n`), doc.code).toBe(
      true,
    );
    expect(body, doc.code).toContain(`# ${doc.code}`);
    expect(body, doc.code).toContain(doc.fix);
    expect(body, doc.code).toContain("## Related pages");
    largest = Math.max(largest, body.length);

    const response = await errorCode(new Request(`http://localhost/api/error-code/${doc.code}`), {
      params: Promise.resolve({ code: doc.code }),
    });
    expect(response.status, doc.code).toBe(200);
    expect(response.headers.get("content-type"), doc.code).toContain("text/markdown");
    expect(await response.text()).toBe(body);
  }
  console.log(`error twins ${String(ERROR_DOCS.length)} largest chars ${String(largest)}`);
}, 60_000);

test("an unknown code is a markdown 404 with suggestions", async () => {
  const response = await errorCode(new Request("http://localhost/api/error-code/OKM0000"), {
    params: Promise.resolve({ code: "OKM0000" }),
  });
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/markdown");
  const body = await response.text();
  expect(body).toContain("# Not found");
  expect(body).toContain("OKM0000.md");
  expect(body).toContain("](");
});

test("Accept markdown and the .md URL both rewrite to the per-code route", () => {
  expect(errorCodeRewrite("/docs/reference/errors/OKM1101.md", false)).toBe("OKM1101");
  expect(errorCodeRewrite("/docs/reference/errors/okm1101", true)).toBe("OKM1101");
  expect(errorCodeRewrite("/docs/reference/errors/OKM1101", false)).toBeUndefined();
  expect(errorCodeRewrite("/docs/reference/errors.md", true)).toBeUndefined();
  expect(errorCodeRewrite("/docs/reference/errors", true)).toBeUndefined();
});

test("a searched code redirects a browser to the Errors anchor and markdown Accept returns the twin", async () => {
  const hit = searchHandbook("OKM1101", 1)[0];
  if (hit === undefined) throw new Error("OKM1101 has no search hit");
  expect(hit.url).toBe("/docs/reference/errors#okm1101");
  expect(hit.markdown).toBe(absoluteDocsUrl(errorCodeMarkdownUrl("OKM1101")));

  const clicked = new URL(hit.url, "http://localhost");
  const page = proxy(browserRequest(clicked.pathname));
  expect(page.status).toBe(200);
  expect(rewriteTarget(page)).toBeUndefined();
  expect(errorsPage()).toContain(`id="${clicked.hash.slice(1)}"`);

  const browser = proxy(browserRequest("/docs/reference/errors/OKM1101"));
  expect(browser.status).toBe(308);
  expect(browser.headers.get("vary")).toContain("Accept");
  const location = browser.headers.get("location") ?? "";
  const landed = new URL(location, "http://localhost");
  expect(`${landed.pathname}${landed.hash}`).toBe(hit.url);
  const followed = proxy(browserRequest(landed.pathname));
  expect(followed.status).toBe(200);
  expect(rewriteTarget(followed)).toBeUndefined();

  const markdown = proxy(browserRequest("/docs/reference/errors/OKM1101", "text/markdown"));
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get("vary")).toContain("Accept");
  expect(rewriteTarget(markdown)).toBe("/api/error-code/OKM1101");
  const twin = await errorCode(new Request("http://localhost/api/error-code/OKM1101"), {
    params: Promise.resolve({ code: "OKM1101" }),
  });
  expect(twin.status).toBe(200);
  expect(twin.headers.get("content-type")).toContain("text/markdown");
  const expected = renderErrorCodeMarkdown("OKM1101");
  if (expected === undefined) throw new Error("missing twin OKM1101");
  expect(await twin.text()).toBe(expected);
});

test("an unknown extensionless code stays a 404", async () => {
  const response = proxy(browserRequest("/docs/reference/errors/OKM0000"));
  expect(response.status).not.toBe(308);
  expect(response.headers.get("location")).toBeNull();
  expect(rewriteTarget(response)).toBe("/missing/docs/reference/errors/OKM0000");
  const page = await missing(new Request("http://localhost/missing/docs/reference/errors/OKM0000"), {
    params: Promise.resolve({ path: ["docs", "reference", "errors", "OKM0000"] }),
  });
  expect(page.status).toBe(404);
  const body = await page.text();
  expect(body).toContain("OKM0000");
  expect(body).toContain("href=");
});

test("every registry code redirects to an anchor on the Errors page", () => {
  const page = errorsPage();
  for (const doc of ERROR_DOCS) {
    const target = errorCodeBrowserRedirect(`/docs/reference/errors/${doc.code}`);
    expect(target, doc.code).toBe(errorCodeHtmlUrl(doc.code));
    const response = proxy(browserRequest(`/docs/reference/errors/${doc.code}`));
    expect(response.status, doc.code).toBe(308);
    expect(response.headers.get("vary"), doc.code).toContain("Accept");
    const location = new URL(response.headers.get("location") ?? "", "http://localhost");
    expect(`${location.pathname}${location.hash}`, doc.code).toBe(errorCodeHtmlUrl(doc.code));
    expect(page.includes(`id="${doc.code.toLowerCase()}"`), doc.code).toBe(true);
  }
});

/**
 * Browser request. `accept` is omitted for a normal navigation.
 *
 * @param path - Path and optional hash
 * @param accept - Accept header
 */
function browserRequest(path: string, accept?: string): NextRequest {
  const headers = new Headers();
  if (accept !== undefined) headers.set("Accept", accept);
  return new NextRequest(`http://localhost${path}`, { headers });
}

/**
 * Rewrite destination pathname, when the proxy rewrote instead of answering.
 *
 * @param response - Proxy response
 */
function rewriteTarget(response: Response): string | undefined {
  const header = response.headers.get("x-middleware-rewrite");
  if (header === null) return undefined;
  return new URL(header, "http://localhost").pathname;
}

/**
 * Errors page source, which holds the code anchors.
 */
function errorsPage(): string {
  return readFileSync(join(siteRoot(), "content/docs/reference/errors.mdx"), "utf8");
}
