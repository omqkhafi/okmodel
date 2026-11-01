/**
 * MDX → pack Markdown flattening and link rewrite.
 */

import { expect, test } from "bun:test";

import {
  codesInText,
  mdxComponentsToMarkdown,
  relativePackLink,
  rewriteHandbookLinks,
  stripSiteOnlyChrome,
  stripYamlFrontmatter,
} from "../scripts/docs-mdx.js";

test("front matter strip matches the site twin helper", () => {
  expect(stripYamlFrontmatter("---\ntitle: A\n---\n\nBody\n")).toBe("Body\n");
});

test("Callout, Tabs, Steps, and Anatomy become plain Markdown", () => {
  const raw = `
<Callout type="info" title="Note">
Hello.
</Callout>

<Tabs items={["a", "b"]}>
<Tab value="a">

One

</Tab>
<Tab value="b">

Two

</Tab>
</Tabs>

<Steps>
<Step>
### First
Do it.
</Step>
</Steps>

<Anatomy call="table" shape="args">
  <AnatomyPart slot="name" label="Name" code='"notes",' mark="name">
    An empty name is refused.
  </AnatomyPart>
</Anatomy>
`;
  const out = mdxComponentsToMarkdown(raw);
  expect(out).toContain("> **Note**");
  expect(out).toContain("> Hello.");
  expect(out).toContain("### a");
  expect(out).toContain("### b");
  expect(out).toContain("### First");
  expect(out).toContain("`table()`");
  expect(out).toContain("**Name**");
  expect(out).not.toMatch(/<\/?(Callout|Tabs|Tab|Steps|Step|Anatomy)\b/);
});

test("handbook links rewrite to pack paths and error pages", () => {
  const map = new Map([["/docs/migrations/backfill", "backfill.md"]]);
  const { text, unrewritten } = rewriteHandbookLinks(
    "See [Backfill](/docs/migrations/backfill) and [OKM1401](/docs/reference/errors#okm1401) and [Drivers](/docs/operate/drivers).",
    "guide.md",
    map,
  );
  expect(text).toContain("[Backfill](backfill.md)");
  expect(text).toContain("[OKM1401](errors/OKM1401.md)");
  expect(text).toContain("[Drivers](https://okm.omqkhafi.dev/docs/operate/drivers)");
  expect(unrewritten).toEqual(["/docs/operate/drivers"]);
  expect(relativePackLink("errors/OKM1.md", "guide.md")).toBe("../guide.md");
  expect(codesInText("OKM1401 and OKM1401")).toEqual(["OKM1401"]);
});

test("site-only chrome is stripped from pack bodies", () => {
  const body = `# Title

Prose.

The package copy is [\`docs/x.md\`](https://github.com/omqkhafi/okmodel/blob/main/docs/x.md) on main.

| Next | You use it for |
| --- | --- |
| [Drivers](/docs/operate/drivers) | Pick a driver. |
`;
  const out = stripSiteOnlyChrome(body);
  expect(out).toContain("Prose.");
  expect(out).not.toContain("package copy");
  expect(out).not.toContain("| Next |");
});
