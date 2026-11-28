/**
 * The chip shows the engine name and the minimum, and the markdown line is
 * the same rule.
 */

import { createElement } from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SupportChipView } from "../components/support-chip";
import { annotateFeatureMarkdown, chipForAttributes } from "./feature-heading";
import { FEATURE_RULES } from "./generated/feature-rules";
import { getPageSourceMarkdown } from "./page-markdown";
import { source } from "./source";

function chipMarkup(rule: NonNullable<(typeof FEATURE_RULES)["column.generated"]>, open: boolean): string {
  return renderToStaticMarkup(createElement(SupportChipView, { rule, open }));
}

test("the markdown line equals the chip rule", () => {
  const generated = FEATURE_RULES["column.generated"];
  const temporal = FEATURE_RULES["temporal.keys"];
  if (generated === undefined || temporal === undefined) throw new Error("pilot rules missing");
  const body = annotateFeatureMarkdown(
    ['### Generated [feature="column.generated"]', "", "Stored.", "", "```ts", '### Generated [feature="column.generated"]', "```"].join(
      "\n",
    ),
  );
  expect(body).toContain(`### Generated\n\n${generated.line}`);
  expect(body).toContain('```ts\n### Generated [feature="column.generated"]\n```');
  const markup = chipMarkup(generated, false);
  expect(markup).toContain("PostgreSQL");
  expect(markup).toContain(generated.label);
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('role="tooltip"');
  const open = chipMarkup(temporal, true);
  expect(open).toContain('role="tooltip"');
  expect(open).toContain(temporal.label);
  expect(open).toContain(">15<");
  expect(open).toContain(">18<");
  expect(open).toContain(">19<");
  expect(open).toContain(">yes<");
  expect(open).toContain(">no<");
  expect(open).toContain(">tested<");
  expect(open).toContain(">not tested<");
  expect(open).toContain(temporal.line);
  const docsOnly = chipForAttributes({ engines: "postgres" });
  expect(docsOnly?.docsOnly).toBe(true);
  expect(docsOnly?.line).toContain("docs only, no proof");
  expect(docsOnly?.label).toBe("15+");
});

test("pilot pages publish the chip line in markdown and in search", async () => {
  const generated = FEATURE_RULES["column.generated"];
  const exclusion = FEATURE_RULES["constraint.exclusion"];
  const temporal = FEATURE_RULES["temporal.keys"];
  if (generated === undefined || exclusion === undefined || temporal === undefined) {
    throw new Error("pilot rules missing");
  }
  const defaults = source.getPage(["schema", "defaults"]);
  const ranges = source.getPage(["schema", "range-types"]);
  if (defaults === undefined || ranges === undefined) throw new Error("pilot pages missing");
  const defaultsMd = await getPageSourceMarkdown(defaults);
  const rangesMd = await getPageSourceMarkdown(ranges);
  expect(defaultsMd).toContain(generated.line);
  expect(defaultsMd).not.toContain("[feature=");
  expect(rangesMd).toContain(exclusion.line);
  expect(rangesMd).toContain(temporal.line);
  expect(JSON.stringify(defaults.data.structuredData)).toContain(generated.line);
  expect(JSON.stringify(ranges.data.structuredData)).toContain(temporal.line);
});
