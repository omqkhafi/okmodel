-- class: expand
-- name: init

-- class: expand
-- kind: create-role
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create role "ref_app" with nosuperuser nocreatedb nocreaterole inherit login;

-- class: expand
-- kind: grant-default
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter default privileges for role "okm" in schema "public" grant execute on functions to "ref_app";

-- class: expand
-- kind: grant-default
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter default privileges for role "okm" in schema "public" grant select on sequences to "ref_app";

-- class: expand
-- kind: grant-default
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter default privileges for role "okm" in schema "public" grant usage on sequences to "ref_app";

-- class: expand
-- kind: grant-default
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter default privileges for role "okm" in schema "public" grant delete on tables to "ref_app";

-- class: expand
-- kind: grant-default
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter default privileges for role "okm" in schema "public" grant insert on tables to "ref_app";

-- class: expand
-- kind: grant-default
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter default privileges for role "okm" in schema "public" grant select on tables to "ref_app";

-- class: expand
-- kind: grant-default
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter default privileges for role "okm" in schema "public" grant update on tables to "ref_app";

-- class: expand
-- kind: create-enum
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create type "public"."task_status" as enum ('todo', 'doing', 'done');

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."comments" (
  "author_id" uuid not null,
  "body" text not null,
  "created_at" timestamptz not null default now(),
  "id" uuid not null default gen_random_uuid(),
  "task_id" uuid not null,
  "updated_at" timestamptz not null default now(),
  "workspace_id" uuid not null,
  constraint "comments_pkey" primary key ("id", "workspace_id")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."comments" add constraint "comments_id_workspaceId_key" unique ("id", "workspace_id");

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."members" (
  "created_at" timestamptz not null default now(),
  "email" text not null,
  "id" uuid not null default gen_random_uuid(),
  "name" text not null,
  "updated_at" timestamptz not null default now(),
  "workspace_id" uuid not null,
  constraint "members_pkey" primary key ("id", "workspace_id")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."comments" add constraint "comments_author_id_fkey" foreign key ("author_id", "workspace_id") references "public"."members" ("id", "workspace_id");

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."members" add constraint "members_email_key" unique ("workspace_id", "email");

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."members" add constraint "members_id_workspaceId_key" unique ("id", "workspace_id");

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."projects" (
  "archive_id" uuid,
  "archived_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "id" uuid not null default gen_random_uuid(),
  "name" text not null,
  "owner_id" uuid not null,
  "slug" text not null,
  "updated_at" timestamptz not null default now(),
  "workspace_id" uuid not null,
  constraint "projects_pkey" primary key ("id", "workspace_id")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."projects" add constraint "projects_owner_id_fkey" foreign key ("owner_id", "workspace_id") references "public"."members" ("id", "workspace_id");

-- class: expand
-- kind: create-index
-- action: ddl
-- lock: SHARE
create unique index "projects_id_workspace_id_idx" on "public"."projects" ("id", "workspace_id") where (archived_at IS NULL);

-- class: expand
-- kind: create-index
-- action: ddl
-- lock: SHARE
create unique index "projects_workspace_id_slug_idx" on "public"."projects" ("workspace_id", "slug") where (archived_at IS NULL);

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."tasks" (
  "archive_id" uuid,
  "archived_at" timestamptz,
  "assignee_id" uuid,
  "created_at" timestamptz not null default now(),
  "id" uuid not null default gen_random_uuid(),
  "project_id" uuid not null,
  "share_token" text,
  "status" task_status not null,
  "title" text not null,
  "updated_at" timestamptz not null default now(),
  "workspace_id" uuid not null,
  constraint "tasks_pkey" primary key ("id", "workspace_id")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."comments" add constraint "comments_task_id_fkey" foreign key ("task_id", "workspace_id") references "public"."tasks" ("id", "workspace_id");

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" add constraint "tasks_assignee_id_fkey" foreign key ("assignee_id", "workspace_id") references "public"."members" ("id", "workspace_id");

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" add constraint "tasks_project_id_fkey" foreign key ("project_id", "workspace_id") references "public"."projects" ("id", "workspace_id");

-- class: expand
-- kind: create-index
-- action: ddl
-- lock: SHARE
create unique index "tasks_id_workspace_id_idx" on "public"."tasks" ("id", "workspace_id") where (archived_at IS NULL);

-- class: expand
-- kind: create-table
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create table "public"."workspaces" (
  "created_at" timestamptz not null default now(),
  "id" uuid not null default gen_random_uuid(),
  "name" text not null,
  "slug" text not null,
  "updated_at" timestamptz not null default now(),
  constraint "workspaces_pkey" primary key ("id")
);

-- class: expand
-- kind: add-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."workspaces" add constraint "workspaces_slug_key" unique ("slug");

-- class: expand
-- kind: create-function
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create function "public"."task_is_open"("status" task_status) returns boolean language sql immutable security invoker as $okm$select status <> 'done'::task_status$okm$;

-- class: expand
-- kind: create-view
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create view "public"."active_projects" as SELECT workspace_id,
    id,
    name
   FROM projects
  WHERE archived_at IS NULL;

-- class: expand
-- kind: create-view
-- action: ddl
-- lock: ACCESS EXCLUSIVE
create view "public"."open_tasks" as SELECT workspace_id,
    project_id,
    count(*) AS open_tasks
   FROM tasks
  WHERE task_is_open(status) AND archived_at IS NULL
  GROUP BY workspace_id, project_id;

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant execute on function "public"."task_is_open"(task_status) to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant delete on table "public"."comments" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant insert on table "public"."comments" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant select on table "public"."comments" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant update on table "public"."comments" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant delete on table "public"."members" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant insert on table "public"."members" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant select on table "public"."members" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant update on table "public"."members" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant delete on table "public"."projects" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant insert on table "public"."projects" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant select on table "public"."projects" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant update on table "public"."projects" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant delete on table "public"."tasks" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant insert on table "public"."tasks" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant select on table "public"."tasks" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant update on table "public"."tasks" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant delete on table "public"."workspaces" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant insert on table "public"."workspaces" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant select on table "public"."workspaces" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant update on table "public"."workspaces" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant delete on table "public"."active_projects" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant insert on table "public"."active_projects" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant select on table "public"."active_projects" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant update on table "public"."active_projects" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant delete on table "public"."open_tasks" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant insert on table "public"."open_tasks" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant select on table "public"."open_tasks" to "ref_app";

-- class: expand
-- kind: grant
-- action: ddl
-- lock: ACCESS EXCLUSIVE
grant update on table "public"."open_tasks" to "ref_app";
