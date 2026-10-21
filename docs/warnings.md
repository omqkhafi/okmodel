---
okmVersion: "0.10.0"
since: "0.10"
dialects: [postgres]
codes: [OKM2004, OKM2005, OKM2007, OKM2008]
---
# Warnings

OKModel refusals are `OKM1xxx`. Advice is a separate channel. `OKM2xxx` is a warning and `OKM3xxx` is a hint. The number records the subject only. The level is configuration: `off`, `hint`, `warn`, or `error`. A code is never reused or renumbered.

`okmodel/warnings` is experimental. It exports `warnings`. Pass the function to `connect`. A process that does not import it does not load the rules.

```ts
import { connect } from "okmodel/pg/postgresjs";
import { warnings } from "okmodel/warnings";

export const db = connect(process.env.DATABASE_URL ?? "", {
  schema: app,
  warnings: warnings({
    levels: { "deep-offset": "error" },
    ignore: [{ rule: "wide-fan-out", reason: "tenant cap" }],
  }),
});
```

## Levels

In development, low severity is a hint, and medium or high severity is a warn. The console line includes the call site. In production, every rule is off until `levels` sets one. `error` is opt-in and throws `OkmError` on every evaluation. It is there for a test.

`env: "development"` or `env: "production"` overrides `NODE_ENV`. Any other `NODE_ENV`, including an unset one, is development.

`onWarning` replaces the console. The notice has the error-object fields plus `level`, `severity`, and `rule`. The same rule and call site are reported once per process. `error` is not deduplicated.

## Ignore

An ignore is `{ rule, reason }`. `reason` is required at the call site and in the project config. The rule id is kebab-case. An unknown id is kept so a later rule can use it. It does not report a stale-ignore finding.

```ts
await db.notes.find({
  limit: 10,
  ignore: { rule: "unordered-limit", reason: "one row" },
});
```

`defineConfig({ warnings })` accepts `levels` and `ignore`. `okm check` lists each project ignore with its rule and reason. The reason is untrusted text (`user.query`). `okm check` does not run the query rules.

## Rules

| Code | Rule | Fires when |
| --- | --- | --- |
| OKM2004 | `deep-offset` | `offset` is an integer above 1,000. `page()` has no offset. |
| OKM2005 | `unordered-limit` | `find` has a numeric `limit` and `orderBy` is missing or does not end in a primary key or unique column. |
| OKM2007 | `large-in-list` | `inList`, `notIn`, an array operator, or a plain array is longer than 500 elements. `and`, `or`, `not`, and `between` are not value lists. |
| OKM2008 | `wide-fan-out` | One include path multiplies the parent limit by nested limits above 10,000. A to-one include with no limit counts as 1. Sibling includes are separate products. |

OKM2011 is not part of this channel yet.

The fix for a deep offset is `page()` with a cursor. The fix for a large list is `= any(array)`, so the list is one parameter. The fix for a wide include is a lower parent limit or a lower include limit. The fix for an unordered limit is an `orderBy` that ends with the primary key or a unique column.

Pages: [OKM2004](errors/OKM2004.md), [OKM2005](errors/OKM2005.md), [OKM2007](errors/OKM2007.md), [OKM2008](errors/OKM2008.md).
