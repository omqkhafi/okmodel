---
okmVersion: "0.10.0"
since: "0.10"
dialects: [postgres]
codes: [OKM2004, OKM2005, OKM2007, OKM2008, OKM2011, OKM2101, OKM2102, OKM2103]
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

`defineConfig({ warnings })` accepts `levels` and `ignore`. `okm check` lists each project ignore with its rule and reason. The reason is untrusted text (`user.query`). `okm check` does not run the query rules. It runs the schema rules below.

A project ignore may carry a `target`: a table (`events`) or a column (`orders.user_id`), in SQL names. The target narrows the ignore to that table or column. Without a target the ignore covers every finding of its rule. A call-site ignore has no target. A project ignore with a target never silences a query rule.

## Rules

| Code | Rule | Fires when |
| --- | --- | --- |
| OKM2004 | `deep-offset` | `offset` is an integer above 1,000. `page()` has no offset. |
| OKM2005 | `unordered-limit` | `find` has a numeric `limit` and `orderBy` is missing or does not end in a primary key or unique column. Under `for()`, the tenant key is ignored, so the rest of that unique counts. |
| OKM2007 | `large-in-list` | `inList`, `notIn`, an array operator, or a plain array is longer than 500 elements. `and`, `or`, `not`, and `between` are not value lists. |
| OKM2008 | `wide-fan-out` | One include path multiplies the parent limit by nested limits above 10,000. A to-one include with no limit counts as 1. Sibling includes are separate products. |
| OKM2011 | `default-limit-reached` | A read took a default from `connect({ limits })` and returned exactly that many rows. A `find` with a default, a to-many include with a default (at any depth), or an aggregate with `groupBy` and a default. A limit the call wrote, `.all(reason)`, `page()`, and `stream()` never fire it. |

OKM2011 is a result rule (evidence `observed`): it needs the rows, so it runs after the read and never on `.inspect()` or `.sql()`. It exists only when `connect` has `limits` and `warnings`. The notice has a `limit` field that names the key and the value, for example `limits.find = 50`, and the console prints it as a `Limit:` line. Without `limits` nothing is applied and nothing fires. Defaults are opt-in: The handbook page Limits (Define, Connect) has the keys, `max`, and the list of calls they leave alone.

## Schema rules in `okm check`

These three rules read the schema, the catalog, and the project source. They need no database and no running app. `okm check` evaluates them in phase `check` with static evidence. A level comes from `warnings.levels`, or the registry default (`warn`, severity medium). A project has no environment here, so a production build does not turn them off.

| Code | Rule | Fires when |
| --- | --- | --- |
| OKM2101 | `unindexed-foreign-key` | No index, primary key, or unique constraint starts with the columns of a foreign key. A composite index that starts with them counts, in any order of those columns. |
| OKM2102 | `table-without-primary-key` | A managed table has no primary key. A unique index does not replace one. |
| OKM2103 | `unindexed-filter-column` | A column is in a `filters()` allow list or sort list, or used by a preset, and no index starts with it. A primary key or unique index counts. On a tenant table the tenant column prefix counts. |

`okm check` prints one line per finding and one `warnings[]` entry with `place` set to the target (`orders.user_id`). It exits 0. A rule at level `error` makes it exit non-zero with that rule's code and every error finding in the message. `off` drops the rule. A table that declares no key on purpose is silenced with a project ignore:

```ts
export default defineConfig({
  schema: "./schema.ts",
  warnings: {
    levels: { "unindexed-filter-column": "error" },
    ignore: [
      { rule: "table-without-primary-key", target: "events", reason: "append-only log" },
    ],
  },
});
```

Every project ignore is listed with its reason. For these three rules the entry also has `status`: `applied` when a finding matched, `stale` when none did. A stale ignore is reported as a warning. An ignore for another rule has no status.

A rule stays silent when it cannot decide:

- An index with an expression makes the columns it names undecidable. The rule does not fire for them.
- A partial index counts as an index.
- A preset is run once with its builder and no arguments. A preset that throws without its arguments adds nothing. A name that is not a column of the table is skipped.
- `filters()` is read from source, because the call keeps nothing at runtime. `okm check` reads the `raw.include` files (default `src/**`), the schema file, and the `tables` directory. A call counts when its receiver is an identifier bound to one `table("name", ...)`. Only literal `allow` keys and literal `sort` strings are read. A spread, a computed key, an unknown receiver, or a name bound to two tables adds nothing.
- An external or ignored table is not checked.

The fix for a deep offset is `page()` with a cursor. The fix for a large list is `= any(array)`, so the list is one parameter. The fix for a wide include is a lower parent limit or a lower include limit. The fix for a default limit that was reached is a limit that fits the call, `page()`, or `.all(reason)`. The fix for an unordered limit is an `orderBy` that ends with the primary key or a unique column.

Pages: [OKM2004](errors/OKM2004.md), [OKM2005](errors/OKM2005.md), [OKM2007](errors/OKM2007.md), [OKM2008](errors/OKM2008.md), [OKM2011](errors/OKM2011.md), [OKM2101](errors/OKM2101.md), [OKM2102](errors/OKM2102.md), [OKM2103](errors/OKM2103.md).
