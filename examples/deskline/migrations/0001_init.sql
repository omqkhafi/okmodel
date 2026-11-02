-- class: expand
-- name: init

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."api_keys" (
  "id" uuid not null default gen_random_uuid(),
  "keyHash" text not null,
  "tenantId" uuid not null,
  constraint "api_keys_pkey" primary key ("id")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."api_keys" add constraint "api_keys_keyHash_key" unique ("keyHash");

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."tenants" (
  "id" uuid not null default gen_random_uuid(),
  "name" text not null,
  constraint "tenants_pkey" primary key ("id")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."api_keys" add constraint "api_keys_tenantId_fkey" foreign key ("tenantId") references "public"."tenants" ("id");

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tenants" add constraint "tenants_name_key" unique ("name");

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."tickets" (
  "id" uuid not null default gen_random_uuid(),
  "subject" text not null,
  "tenantId" uuid not null,
  constraint "tickets_pkey" primary key ("id", "tenantId")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tickets" add constraint "tickets_id_tenantId_key" unique ("id", "tenantId");

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tickets" add constraint "tickets_tenantId_subject_key" unique ("tenantId", "subject");
