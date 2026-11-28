/**
 * The handbook repeated-sentence lint.
 */

import { expect, test } from "bun:test";

import { handbookSentenceProblems, repeatedSentenceProblems } from "../scripts/docs-sentences.js";
import { repoRoot } from "../scripts/root.js";

const LONG = "Alpha sentence that is definitely long enough to count as prose.";

test("three pages that share a long sentence fail", () => {
  const pages = ["a.mdx", "b.mdx", "c.mdx"].map((path) => ({
    path,
    text: LONG,
  }));
  const problems = repeatedSentenceProblems(pages);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("3 pages");
});

test("two pages may share a sentence", () => {
  expect(
    repeatedSentenceProblems([
      { path: "a.mdx", text: LONG },
      { path: "b.mdx", text: LONG },
    ]),
  ).toEqual([]);
});

test("a fence and a support component are not page text", () => {
  const shared = "This generated line would be a problem if it were page text here.";
  const text = `---\ntitle: "T"\n---\n\n\`\`\`ts\n${shared}\n\`\`\`\n\n<SupportPhrase />\n\n<Tagline />\n`;
  expect(
    repeatedSentenceProblems([
      { path: "a.mdx", text },
      { path: "b.mdx", text },
      { path: "c.mdx", text },
    ]),
  ).toEqual([]);
});

test("a sentence shorter than 40 characters is ignored", () => {
  const short = "Short sentence stays allowed.";
  expect(
    repeatedSentenceProblems([
      { path: "a.mdx", text: short },
      { path: "b.mdx", text: short },
      { path: "c.mdx", text: short },
    ]),
  ).toEqual([]);
});

test("the handbook has no repeated sentence", () => {
  expect(handbookSentenceProblems(repoRoot())).toEqual([]);
});
