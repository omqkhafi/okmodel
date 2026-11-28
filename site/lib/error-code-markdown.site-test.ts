/**
 * Every registry code has a short markdown twin, and the Errors page `.md`
 * is an index whose links are those twins.
 */

import { expect, test } from "bun:test";

import { GET as errorCode } from "../app/api/error-code/[code]/route";
import { ERROR_DOCS } from "../../src/tooling/errors/registry.js";
import { renderPageMarkdown } from "./agent-docs";
import { ERROR_CODE_CHAR_LIMIT, ERROR_INDEX_CHAR_LIMIT, renderErrorCodeMarkdown } from "./error-code-markdown";
import { errorCodeMarkdownUrl, errorCodeRewrite } from "./error-code-path";
import { ERROR_FIXES } from "./generated/error-fixes";
import { absoluteDocsUrl } from "./markdown-url";

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
