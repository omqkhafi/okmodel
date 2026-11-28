/**
 * "I want to…" tasks.
 *
 * One list. The handbook page is {@link renderTaskPage}. Search synonyms and
 * `llms-core.txt` read this module. A task href is a handbook path, plus an
 * anchor when the sentence points at a heading.
 */

/** One task and the page that answers it. */
export type DocsTask = {
  /** What the reader is trying to do, one line. */
  readonly task: string;
  /** Absolute handbook path, optional `#anchor`. */
  readonly href: string;
};

/** The task index, in the order the page prints. */
export const DOCS_TASKS: readonly DocsTask[] = [
  { task: "Install okmodel and open a client", href: "/docs/start/installation" },
  { task: "Run a first query in a few minutes", href: "/docs/start/first-query" },
  { task: "See which files a project has", href: "/docs/start/project-structure" },
  { task: "Push a schema to an empty database", href: "/docs/start/first-schema" },
  { task: "Generate and apply the first migration", href: "/docs/start/first-migration" },
  { task: "Check a target before it serves traffic", href: "/docs/start/production" },
  { task: "Look up the command and the call I use every day", href: "/docs/start/cheat-sheet" },
  { task: "See why a read with no limit is refused", href: "/docs/start/why-okmodel" },
  { task: "See how one schema becomes queries and SQL", href: "/docs/concepts/how-okmodel-works" },
  { task: "Declare a table", href: "/docs/schema/tables" },
  { task: "Pick a column type", href: "/docs/schema/columns" },
  { task: "Store text", href: "/docs/schema/text-columns" },
  { task: "Store a number or a sequence", href: "/docs/schema/number-columns" },
  { task: "Store a time", href: "/docs/schema/time-columns" },
  { task: "Store JSON, bytes, or an id", href: "/docs/schema/binary-json-id-columns" },
  { task: "Fill a column when the insert omits it", href: "/docs/schema/defaults" },
  { task: "Add an enum, an array, or a picklist", href: "/docs/schema/enums-arrays-picklists" },
  { task: "Add a composite type", href: "/docs/schema/composite-types" },
  { task: "Add a range column", href: "/docs/schema/range-types" },
  { task: "Choose a primary key", href: "/docs/schema/keys-and-identity" },
  { task: "Reference another table", href: "/docs/schema/references" },
  { task: "Load a related row", href: "/docs/schema/relations" },
  { task: "Add an index", href: "/docs/schema/indexes" },
  { task: "Add a check", href: "/docs/schema/checks" },
  { task: "Validate a write in the application", href: "/docs/schema/validation" },
  { task: "Hide or guard a column", href: "/docs/schema/visibility" },
  { task: "Keep one tenant's rows apart from another's", href: "/docs/schema/tenancy" },
  { task: "Add a row policy", href: "/docs/schema/policies" },
  { task: "Add a view", href: "/docs/schema/views" },
  { task: "Add a function", href: "/docs/schema/functions" },
  { task: "Add a procedure", href: "/docs/schema/procedures" },
  { task: "Add a trigger", href: "/docs/schema/triggers" },
  { task: "React to DDL in the whole database", href: "/docs/schema/event-triggers" },
  { task: "Enable an extension", href: "/docs/schema/extensions" },
  { task: "Store a vector", href: "/docs/schema/extensions#pgvector" },
  { task: "Compare strings by similarity", href: "/docs/schema/extensions#trigram" },
  { task: "Partition a table", href: "/docs/schema/partitions" },
  { task: "Comment a table or a column", href: "/docs/schema/comments" },
  { task: "Name columns in snake case", href: "/docs/schema/names-and-casing" },
  { task: "Split one product across several catalogs", href: "/docs/schema/several-catalogs" },
];

/**
 * Handbook page for {@link DOCS_TASKS}.
 *
 * @returns MDX source, including the trailing newline
 */
export function renderTaskPage(): string {
  const rows = DOCS_TASKS.map((item) => `| ${item.task} | [Open](${item.href}) |`).join("\n");
  return `---
title: "I want to…"
description: "One line for the job, and the page that does it."
summary: "Each line is a job and the page that does it."
since: "0.10"
status: stable
---

## What it does

Find the page for the job. The line is the task. The link is the page.

| I want to… | Page |
| --- | --- |
${rows}

## When to use it

Use this list when you know the job and not the page name.

## When not to

Read [Get started](/docs/start) when you are new to the project. Read [Pick a path](/docs#pick-a-path) when you are coming from another tool.

## Options

There are no calls on this page. Each row is a link.

## What the plan shows

This page does not emit a migration step.

## Errors

This page does not add an error code.

## Version

<SupportPhrase />.

## Gotchas

An anchor on a link opens the heading on that page. The page still loads when the heading moves.

## Related

| Next | You use it for |
| --- | --- |
| [Learning path](/docs/start) | The three steps from a first query to a production check. |
| [Cheat sheet](/docs/start/cheat-sheet) | The commands and the six daily calls. |
`;
}
