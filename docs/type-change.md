---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: [OKM1510, OKM1512, OKM1515, OKM1538]
---
# A type change that rewrites the table

OKM1538 is a warning. It fires when `ALTER TABLE … ALTER COLUMN … TYPE` (or `SET DATA TYPE`) rewrites the heap (D276). There is no automatic safe form in 0.9, and there is no `okm migrate type-change` command (D285). That command is built later only if someone asks for it.

A rewrite takes `ACCESS EXCLUSIVE` for the whole table. The expand/contract recipe below does not. It adds a new column, fills it, keeps both columns in step while old and new code are both deployed, then drops the old column. Each of those is its own migration. `varchar(n)` widening, `varchar` to `text`, and the other no-rewrite classes in [the linter](linter.md) are not this recipe: OKM1538 does not fire for them.

The example changes `prices.cents` (`integer`, cents) to `prices.amount` (`numeric(12,2)`, dollars). `integer` to `numeric` rewrites the heap, so a single `SET DATA TYPE` is the warning this recipe replaces. The same five migrations are applied on Postgres by `tests/type-change-pg.test.ts`.

The table already exists:

```sql
create table "public"."prices" (
  "id" integer primary key,
  "cents" integer not null
);
```

## 1. Add the new column

Expand. The new column is nullable, so the old release keeps writing `cents` and this statement does not rewrite the heap.

```sql
-- class: expand
alter table "public"."prices" add column "amount" numeric(12, 2);
```

## 2. Backfill

Expand. `backfill()` is the header on the step, not a function (D195). The `UPDATE` is idempotent: a row already filled is skipped, and `$1` / `$2` are the key range. `okm migrate apply` runs one batch per transaction. See [backfill](backfill.md).

```sql
-- class: expand
-- backfill table="public"."prices" key="id" batch=1000
-- transactional: false
update "public"."prices"
set "amount" = "cents"::numeric / 100
where "amount" is null
  and ($1::text is null or "id" > $1::integer)
  and ($2::text is null or "id" <= $2::integer);
```

## 3. Dual-write

Expand. Deploy this before any release that writes `amount`. A `BEFORE INSERT OR UPDATE` trigger copies a write to one column onto the other. An old release that sets only `cents` still fills `amount`. A new release that sets only `amount` still fills `cents`. A write that sets both keeps both values.

```sql
-- class: expand
create function "public"."prices_amount_sync"() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.amount is null and new.cents is not null then
      new.amount := new.cents::numeric / 100;
    elsif new.cents is null and new.amount is not null then
      new.cents := (new.amount * 100)::integer;
    end if;
    return new;
  end if;
  if new.cents is distinct from old.cents and new.amount is not distinct from old.amount then
    new.amount := new.cents::numeric / 100;
  elsif new.amount is distinct from old.amount and new.cents is not distinct from old.cents then
    new.cents := (new.amount * 100)::integer;
  end if;
  return new;
end;
$$;
```

```sql
-- class: expand
create trigger "prices_amount_sync"
before insert or update on "public"."prices"
for each row execute function "public"."prices_amount_sync"();
```

## 4. Switch reads

Expand. Ship the release that reads `amount` with this migration, after the backfill has finished. The safe `NOT NULL` form (D193) is what makes that read trustworthy: a check added `NOT VALID`, validated, then `SET NOT NULL`, then the check dropped. The trigger from the previous migration stays, so an old writer still fills `amount`.

```sql
-- class: expand
alter table "public"."prices"
  add constraint "prices_amount_not_null" check ("amount" is not null) not valid;
```

```sql
-- class: expand
alter table "public"."prices" validate constraint "prices_amount_not_null";
```

```sql
-- class: expand
alter table "public"."prices" alter column "amount" set not null;
```

```sql
-- class: expand
alter table "public"."prices" drop constraint "prices_amount_not_null";
```

## 5. Drop the old column

Contract. Ship this only after every release reads and writes `amount`. Dropping the column is OKM1512. Dropping the dual-write function is OKM1515. Each needs a reason on its own step. Dropping the trigger is not a linter finding: it needs no `-- okm-allow`. Put the trigger first, because the function still names `cents`.

A file that starts with `-- class:` and has no blank line before the first statement treats that block as the migration header, so the first statement never becomes a step. Use a name header and a blank line, then the three steps:

```sql
-- name: 0006_drop_cents
-- class: contract

-- class: contract
drop trigger "prices_amount_sync" on "public"."prices";

-- class: contract
-- okm-allow OKM1515: dual-write trigger removed
drop function "public"."prices_amount_sync"();

-- class: contract
-- okm-allow OKM1512: readers and writers use amount
alter table "public"."prices" drop column "cents";
```

An `-- okm-allow OKM1512` on the drop-trigger step is OKM1510: that code does not fire for `DROP TRIGGER`, and apply refuses before any statement runs.
