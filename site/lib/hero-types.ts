/**
 * Types shared by the hero data, its generator, and its tokeniser. They live
 * apart so the hand-written specs and the generated output can both import them.
 */

/** Stable id of a scenario. Also the CSS tone suffix. */
export type HeroScenarioId =
  | "column"
  | "required"
  | "unique"
  | "foreignKey"
  | "index"
  | "rename"
  | "picklist"
  | "dropTable"
  | "timestamps"
  | "archive"
  | "enum"
  | "view"
  | "tenant"
  | "rls"
  | "include"
  | "page"
  | "aggregate"
  | "search"
  | "scoped"
  | "archived"
  | "hiddenRead"
  | "defaultLimits"
  | "noLimit"
  | "writeFilter"
  | "tree"
  | "generated";

/** The part of okmodel a scenario shows. */
export type HeroGroupId = "migrate" | "model" | "query";

/**
 * `add` and `del` are changed lines, `ctx` is context, `hot` is the line a
 * query scenario is about, and `fold` stands for hidden unchanged lines.
 */
export type HeroDiffMark = "add" | "del" | "ctx" | "hot" | "fold";

/** One row of a diff. `n` is the line number in the new file, when the row has one. */
export interface HeroDiffRow {
  readonly n: number | null;
  readonly mark: HeroDiffMark;
  readonly text: string;
}

