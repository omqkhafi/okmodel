-- class: expand
-- name: public_id

-- class: expand
-- kind: add-column
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" add column "public_id" uuid;

-- class: expand
-- kind: set-default
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" alter column "public_id" set default gen_random_uuid();

-- class: expand
-- kind: backfill-expand
-- action: backfill
-- lock: ROW EXCLUSIVE
-- backfill table="public"."tasks" key="id","workspace_id" batch=500
-- transactional: false
update "public"."tasks" set "public_id" = gen_random_uuid() where "public_id" is null and ($1::text is null or ("id", "workspace_id") > ((($1::jsonb)->>0)::uuid, (($1::jsonb)->>1)::uuid)) and ($2::text is null or ("id", "workspace_id") <= ((($2::jsonb)->>0)::uuid, (($2::jsonb)->>1)::uuid));

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" add constraint "tasks_public_id_notnull" check ("public_id" is not null) not valid;

-- class: expand
-- kind: validate-constraint
-- action: ddl
-- lock: SHARE UPDATE EXCLUSIVE
-- okm-allow OKM1531: the backfill in step 3 fills every null and the default covers new rows
alter table "public"."tasks" validate constraint "tasks_public_id_notnull";

-- class: expand
-- kind: add-column
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" alter column "public_id" set not null;

-- class: expand
-- kind: drop-not-null-check
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" drop constraint "tasks_public_id_notnull";
