/**
 * Hero code, tokenised once at build time with the same Shiki themes the
 * handbook code blocks use, so the hero reads like a docs fence.
 */

import { codeToTokens } from "shiki";

import {
  shownScenarios,
  type HeroDiffMark,
  type HeroFinding,
  type HeroGroupId,
  type HeroRule,
  type HeroScenarioId,
  type HeroStep,
} from "./hero";

/** One rendered token: text plus the dual-theme `--shiki-*` colour pair. */
export interface HeroCodeToken {
  readonly content: string;
  readonly style: Record<string, string>;
}

/** One tokenised diff row. A fold row has no tokens. */
export interface HeroDiffView {
  readonly n: number | null;
  readonly mark: HeroDiffMark;
  /** Row text, for a fold row: what is hidden. */
  readonly text: string;
  readonly tokens: ReadonlyArray<HeroCodeToken>;
}

/** One planner statement with its SQL tokenised. */
export interface HeroStepView extends Omit<HeroStep, "sql"> {
  readonly lines: ReadonlyArray<ReadonlyArray<HeroCodeToken>>;
}

/** Fields every scenario view has. */
interface HeroViewBase {
  readonly id: HeroScenarioId;
  readonly group: HeroGroupId;
  readonly label: string;
  readonly note: string;
  readonly href: string;
}

/** A schema edit and what the tooling made of it. */
export interface HeroMigrateView extends HeroViewBase {
  readonly kind: "migrate";
  /** Argument to `okm generate`. */
  readonly name: string;
  readonly diff: ReadonlyArray<HeroDiffView>;
  readonly plan: {
    readonly file: string;
    readonly class: "expand" | "contract";
    readonly steps: ReadonlyArray<HeroStepView>;
  };
  readonly lint: ReadonlyArray<HeroFinding>;
  readonly types: {
    readonly label: string;
    readonly rows: ReadonlyArray<HeroDiffView>;
    readonly more: number;
  } | null;
}

/** A call and what the client did with it. */
export interface HeroQueryView extends HeroViewBase {
  readonly kind: "query";
  readonly code: ReadonlyArray<HeroDiffView>;
  readonly sql: {
    readonly lines: ReadonlyArray<ReadonlyArray<HeroCodeToken>>;
    readonly params: ReadonlyArray<string>;
  };
  readonly result: {
    readonly lines: ReadonlyArray<ReadonlyArray<HeroCodeToken>>;
    readonly count: number | null;
  };
  readonly rules: ReadonlyArray<HeroRule>;
}

/** Everything the stage needs for one scenario. */
export type HeroScenarioView = HeroMigrateView | HeroQueryView;

const THEMES = { light: "github-light", dark: "github-dark" } as const;

async function tokenise(
  text: string,
  lang: "ts" | "sql",
): Promise<ReadonlyArray<ReadonlyArray<HeroCodeToken>>> {
  const { tokens } = await codeToTokens(text, { lang, themes: THEMES, defaultColor: false });
  return tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      style: { ...token.htmlStyle } as Record<string, string>,
    })),
  );
}

/**
 * Tokenise the rows of a diff together, so a changed line is coloured in the
 * context it sits in. Fold rows are not code and carry no tokens.
 */
async function tokeniseRows(
  rows: ReadonlyArray<{ readonly n: number | null; readonly mark: HeroDiffMark; readonly text: string }>,
): Promise<ReadonlyArray<HeroDiffView>> {
  const code = rows.filter((row) => row.mark !== "fold");
  const tokens = await tokenise(code.map((row) => row.text).join("\n"), "ts");
  let next = 0;
  return rows.map((row) => ({
    ...row,
    tokens: row.mark === "fold" ? [] : (tokens[next++] ?? []),
  }));
}

/**
 * Every scenario, tokenised, in walk order.
 */
export async function loadHeroScenarios(): Promise<ReadonlyArray<HeroScenarioView>> {
  return Promise.all(
    shownScenarios().map(async (scenario): Promise<HeroScenarioView> => {
      const base = {
        id: scenario.id,
        group: scenario.group,
        label: scenario.label,
        note: scenario.note,
        href: scenario.href,
      };
      if (scenario.kind === "query") {
        const [code, sql, result] = await Promise.all([
          tokeniseRows(scenario.code),
          tokenise(scenario.sql.text, "sql"),
          tokenise(scenario.result.text, "ts"),
        ]);
        return {
          ...base,
          kind: "query",
          code,
          sql: { lines: sql, params: scenario.sql.params },
          result: { lines: result, count: scenario.result.count },
          rules: scenario.rules,
        };
      }
      const [diff, steps, types] = await Promise.all([
        tokeniseRows(scenario.diff),
        Promise.all(
          scenario.plan.steps.map(async ({ sql, ...step }): Promise<HeroStepView> => ({
            ...step,
            lines: await tokenise(sql, "sql"),
          })),
        ),
        scenario.types === null
          ? Promise.resolve(null)
          : tokeniseRows(scenario.types.rows).then((rows) => ({
              label: scenario.types!.label,
              rows,
              more: scenario.types!.more,
            })),
      ]);
      return {
        ...base,
        kind: "migrate",
        name: scenario.name,
        diff,
        plan: { file: scenario.plan.file, class: scenario.plan.class, steps },
        lint: scenario.lint,
        types,
      };
    }),
  );
}
