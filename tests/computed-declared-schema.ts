/**
 * Authors with posts and comments, on two tenants, with archivable posts.
 *
 * `schema({ computed })` declares one value per verb on `users`, and
 * `commentCount` on `posts`. Reads select them with
 * `true`.
 */

import {
  fragment,
  gte,
  ident,
  integer,
  many,
  one,
  schema,
  table,
  text,
  timestamptz,
} from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

/** Tenant A. */
export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d21";

/** Tenant B. */
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d22";

const users = table(
  "users",
  { id: text().primaryKey(), name: text(), profileId: text().references("profiles").nullable() },
  { relations: { posts: many("posts", "authorId"), profile: one("profiles", "profileId") } },
);

const posts = table(
  "posts",
  {
    id: text().primaryKey(),
    authorId: text().references("users"),
    title: text(),
    views: integer().nullable(),
    draft: text().nullable(),
    secret: text().nullable().hidden(),
    createdAt: timestamptz().nullable(),
  },
  { traits: [archivable()], relations: { comments: many("comments", "postId") } },
);

const comments = table("comments", {
  id: text().primaryKey(),
  postId: text().references("posts"),
  body: text(),
});

const profiles = table("profiles", { id: text().primaryKey(), bio: text().nullable() });

/** Schema under test. */
export const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [users, posts, comments, profiles],
  computed: {
    users: {
      postCount: (u) => u.posts.count(),
      recent: (u) => u.posts.count({ where: { createdAt: gte("2024-01-01T00:00:00.000Z") } }),
      kinds: (u) => u.posts.count({ distinct: "views" }),
      hasDraft: (u) => u.posts.exists({ where: { draft: "yes" } }),
      totalViews: (u) => u.posts.sum("views"),
      meanViews: (u) => u.posts.avg("views"),
      minViews: (u) => u.posts.min("views"),
      maxViews: (u) => u.posts.max("views"),
      weight: (u) => u.posts.sum(fragment`${ident("views")} * 2`),
    },
    posts: { commentCount: (p) => p.comments.count() },
  },
});
