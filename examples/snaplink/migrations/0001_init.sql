-- class: expand
-- name: init

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."clicks" (
  "clicked_at" timestamptz not null default now(),
  "id" bigint generated always as identity not null,
  "link_id" bigint not null,
  constraint "clicks_pkey" primary key ("id")
);

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."links" (
  "created_at" timestamptz not null default now(),
  "id" bigint generated always as identity not null,
  "slug" text not null,
  "url" text not null,
  constraint "links_pkey" primary key ("id")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."links" add constraint "links_slug_key" unique ("slug");

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."clicks" add constraint "clicks_link_id_fkey" foreign key ("link_id") references "public"."links" ("id");
