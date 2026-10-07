-- class: contract
-- name: drop_share_token

-- class: contract
-- kind: drop-column
-- action: ddl
-- lock: ACCESS EXCLUSIVE
-- okm-allow OKM1512: the app reads public_id since 0002_public_id and nothing reads share_token
alter table "public"."tasks" drop column "share_token";
