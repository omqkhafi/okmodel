-- class: expand
-- name: init

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."notes" (
  "id" uuid not null,
  "title" text not null,
  constraint "notes_pkey" primary key ("id")
);
