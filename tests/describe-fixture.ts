/**
 * Schema and statements for the describe nullability proof.
 *
 * The rows match the describe spike: a join, a CTE, a union, a view, a
 * stored generated column, and a CHECK can all look NOT NULL in the catalog
 * and still return SQL NULL, or cannot be proven.
 */

/** DDL and two rows. Statements are split by the migration lexer. */
export const FIXTURE_SQL = `
CREATE TYPE mood AS ENUM ('open', 'closed');
CREATE DOMAIN pos AS integer NOT NULL;
CREATE TABLE item (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  score int NOT NULL,
  note text,
  checked int CHECK (checked IS NOT NULL),
  doubled int GENERATED ALWAYS AS (score * 2) STORED,
  mood mood,
  pos pos,
  tags text[]
);
CREATE TABLE other (id int PRIMARY KEY);
CREATE VIEW item_view AS SELECT id, name FROM item;
CREATE TABLE log (id int);
CREATE FUNCTION stamp() RETURNS int LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (1); RETURN 1; END $$;
INSERT INTO item (name, score, pos, checked) VALUES ('b', 1, 1, 0);
INSERT INTO other (id) VALUES (2);
`;

/** One statement and the property names that must be nullable or not. */
export type ProofCase = {
  /** Statement to describe. */
  readonly sql: string;
  /** Property names proven NOT NULL. */
  readonly notNull: readonly string[];
  /** Property names that stay nullable. */
  readonly nullable: readonly string[];
};

/** Spike cases, plus the simple column and the alias suffixes. */
export const PROOF_CASES: readonly ProofCase[] = [
  {
    sql: "SELECT i.name, o.id AS other_id FROM item i LEFT JOIN other o ON o.id = i.id",
    notNull: [],
    nullable: ["name", "other_id"],
  },
  {
    sql: "SELECT i.name, o.id AS other_id FROM item i RIGHT JOIN other o ON o.id = i.id",
    notNull: [],
    nullable: ["name", "other_id"],
  },
  {
    sql: "WITH j AS (SELECT o.id FROM item i LEFT JOIN other o ON o.id = i.id) SELECT id FROM j",
    notNull: [],
    nullable: ["id"],
  },
  {
    sql: "SELECT name FROM item UNION ALL SELECT name FROM item",
    notNull: [],
    nullable: ["name"],
  },
  {
    sql: "SELECT name FROM item_view",
    notNull: [],
    nullable: ["name"],
  },
  {
    sql: "SELECT doubled FROM item",
    notNull: [],
    nullable: ["doubled"],
  },
  {
    sql: "SELECT checked FROM item",
    notNull: [],
    nullable: ["checked"],
  },
  {
    sql: "SELECT id, name, note FROM item",
    notNull: ["id", "name"],
    nullable: ["note"],
  },
  {
    sql: 'SELECT note AS "note!", name AS "name?" FROM item',
    notNull: ["note"],
    nullable: ["name"],
  },
  {
    sql: "SELECT name FROM item WHERE note = 'left join'",
    notNull: ["name"],
    nullable: [],
  },
  {
    sql: "SELECT name FROM item -- join\n",
    notNull: ["name"],
    nullable: [],
  },
];
