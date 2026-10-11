-- class: contract
-- name: sql_names

-- class: contract
-- kind: rename-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."comments" rename constraint "comments_author_id_fkey" to "comments_author_id_workspace_id_fkey";

-- class: contract
-- kind: rename-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."comments" rename constraint "comments_id_workspaceId_key" to "comments_id_workspace_id_key";

-- class: contract
-- kind: rename-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."comments" rename constraint "comments_task_id_fkey" to "comments_task_id_workspace_id_fkey";

-- class: contract
-- kind: rename-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."members" rename constraint "members_email_key" to "members_workspace_id_email_key";

-- class: contract
-- kind: rename-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."members" rename constraint "members_id_workspaceId_key" to "members_id_workspace_id_key";

-- class: contract
-- kind: rename-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."projects" rename constraint "projects_owner_id_fkey" to "projects_owner_id_workspace_id_fkey";

-- class: contract
-- kind: rename-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" rename constraint "tasks_assignee_id_fkey" to "tasks_assignee_id_workspace_id_fkey";

-- class: contract
-- kind: rename-constraint
-- action: ddl
-- lock: ACCESS EXCLUSIVE
alter table "public"."tasks" rename constraint "tasks_project_id_fkey" to "tasks_project_id_workspace_id_fkey";
