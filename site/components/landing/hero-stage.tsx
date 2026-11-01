/**
 * Hero stage. A tab strip of schema edits, the edit as a diff on the left, and
 * on the right what okmodel does with it: the migration the planner wrote, what
 * the linter says about it, and how the types moved. A clock walks the tabs;
 * hovering the stage pauses it, and a tab pins its scenario. The prism behind
 * the copy and the foot rail read the same scenario.
 *
 * Everything shown is the output of the real tooling (`scripts/hero-derived.ts`).
 */

"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "@/components/chrome/icons";
import { PrismBackdrop } from "@/components/landing/prism-backdrop";
import { cn } from "@/lib/cn";
import { HERO_GROUPS, type HeroFinding, type HeroGroupId, type HeroRule } from "@/lib/hero";
import type {
  HeroCodeToken,
  HeroDiffView,
  HeroMigrateView,
  HeroQueryView,
  HeroScenarioView,
  HeroStepView,
} from "@/lib/hero-code";
import { useClientReducedMotion } from "@/lib/use-client-reduced-motion";
import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/** How long one scenario stays up before the walk moves on. */
const WALK_MS = 5200;

interface HeroWalkValue {
  readonly scenarios: ReadonlyArray<HeroScenarioView>;
  /** Index of the scenario every part of the stage shows. */
  readonly index: number;
  readonly current: HeroScenarioView;
  /** True while the clock is counting toward the next scenario. */
  readonly running: boolean;
  /** Show a scenario. The walk carries on from it. */
  readonly select: (index: number) => void;
  /** Move to the next scenario, or back with a negative delta. Wraps around. */
  readonly step: (delta: number) => void;
  /** Stop or resume the walk, for as long as the pointer is on the stage. */
  readonly pause: (paused: boolean) => void;
}

const HeroWalkContext = createContext<HeroWalkValue | null>(null);

function useHeroWalk(): HeroWalkValue {
  const value = useContext(HeroWalkContext);
  if (value === null) throw new Error("useHeroWalk must be used inside HeroWalkProvider");
  return value;
}

/** Ink of a scenario as a CSS custom property reference, theme aware. */
function toneVar(scenario: HeroScenarioView): string {
  return `var(--okm-tone-${scenario.id})`;
}

/**
 * Owns the walk clock so the tabs, the panels, the prism, and the rail stay on
 * one scenario.
 *
 * @param scenarios - Tokenised scenarios from `loadHeroScenarios()`
 * @param children - Hero content
 */
export function HeroWalkProvider({
  scenarios,
  children,
}: {
  readonly scenarios: ReadonlyArray<HeroScenarioView>;
  readonly children: ReactNode;
}): ReactNode {
  const reduced = useClientReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [walk, setWalk] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "-12% 0px" },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const running = !reduced && inView && !paused;

  // `walk` is a dependency so a manual pick restarts the count.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setWalk((current) => current + 1), WALK_MS);
    return () => window.clearInterval(timer);
  }, [running, walk]);

  const index = walk % scenarios.length;
  const value = useMemo<HeroWalkValue>(
    () => ({
      scenarios,
      index,
      current: scenarios[index]!,
      running,
      select: setWalk,
      step: (delta) =>
        setWalk((current) => (((current % scenarios.length) + delta + scenarios.length) % scenarios.length)),
      pause: setPaused,
    }),
    [scenarios, index, running],
  );

  return (
    <HeroWalkContext.Provider value={value}>
      <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </HeroWalkContext.Provider>
  );
}

/**
 * The prism behind the copy, tinted by the shown scenario so the light is the
 * same ink as the tab.
 */
export function HeroPrism(): ReactNode {
  const { current } = useHeroWalk();
  return <PrismBackdrop tone={toneVar(current)} />;
}

/** Code tokens of one row, in the theme's ink. */
function Tokens({ tokens }: { readonly tokens: ReadonlyArray<HeroCodeToken> }): ReactNode {
  return tokens.map((token, index) => (
    <span key={index} style={token.style}>
      {token.content}
    </span>
  ));
}

/** Rows of a diff or a snippet: line number, marker, code. */
function Diff({ rows }: { readonly rows: ReadonlyArray<HeroDiffView> }): ReactNode {
  return (
    <ol className="shiki font-mono text-xs leading-[1.85] sm:text-[13px]">
      {rows.map((row, index) => {
        if (row.mark === "fold") {
          return (
            <li
              key={index}
              className="px-3 py-0.5 text-center text-[10px] tracking-wide text-fd-muted-foreground/50"
            >
              ⋯ {row.text}
            </li>
          );
        }
        return (
          <li
            key={index}
            className={cn(
              "flex border-s-2 border-transparent pe-3",
              row.mark === "add" && "border-emerald-500/70 bg-emerald-500/10",
              row.mark === "del" && "border-rose-500/70 bg-rose-500/10",
              row.mark === "hot" && "border-fd-foreground/50 bg-fd-foreground/[0.06]",
              row.mark === "ctx" && "opacity-60",
            )}
          >
            <span
              aria-hidden
              className="w-9 shrink-0 pe-2 text-right text-[10px] text-fd-muted-foreground/40 select-none"
            >
              {row.n ?? ""}
            </span>
            <span
              aria-hidden
              className={cn(
                "w-4 shrink-0 select-none",
                row.mark === "add" && "text-emerald-600 dark:text-emerald-400",
                row.mark === "del" && "text-rose-600 dark:text-rose-400",
                row.mark === "hot" && "text-fd-foreground/60",
              )}
            >
              {row.mark === "add" ? "+" : row.mark === "del" ? "−" : row.mark === "hot" ? "›" : ""}
            </span>
            <code className="min-w-0 flex-1 bg-transparent whitespace-pre">
              <span className="sr-only">
                {row.mark === "add" ? "added: " : row.mark === "del" ? "removed: " : ""}
              </span>
              <Tokens tokens={row.tokens} />
            </code>
          </li>
        );
      })}
    </ol>
  );
}

/** Small label chip, used for the step class, the lint severity, and a rule's origin. */
function Chip({
  tone,
  children,
}: {
  readonly tone: "expand" | "contract" | "error" | "warning" | "clean" | "quiet";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded border px-1.5 font-mono text-[10px] leading-none tracking-wide uppercase",
        tone === "expand" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "contract" &&
          "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300",
        tone === "error" && "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        tone === "warning" &&
          "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300",
        tone === "clean" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "quiet" && "border-fd-border text-fd-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Section frame for the right column: a label, a trailing summary, then the body. */
function Section({
  label,
  trailing,
  children,
}: {
  readonly label: string;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="border-b border-fd-border last:border-b-0">
      <h3 className="flex items-center justify-between gap-3 px-4 pt-3 pb-1.5 font-mono text-[10px] font-normal tracking-[0.14em] text-fd-muted-foreground uppercase">
        <span>{label}</span>
        {trailing === undefined ? null : (
          <span className="min-w-0 truncate tracking-normal normal-case">{trailing}</span>
        )}
      </h3>
      <div className="px-4 pb-3">{children}</div>
    </section>
  );
}

/** SQL as tokenised lines. */
function Sql({
  lines,
}: {
  readonly lines: ReadonlyArray<ReadonlyArray<HeroCodeToken>>;
}): ReactNode {
  return (
    <pre className="shiki font-mono text-[11.5px] leading-[1.7]">
      <code className="block bg-transparent whitespace-pre-wrap [overflow-wrap:anywhere]">
        {lines.map((tokens, row) => (
          <span key={row} className="block">
            <Tokens tokens={tokens} />
          </span>
        ))}
      </code>
    </pre>
  );
}

/** The statements the planner wrote, in order, each with its class and locks. */
function Plan({ steps }: { readonly steps: ReadonlyArray<HeroStepView> }): ReactNode {
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((step, index) => (
        <li key={index} className="flex gap-2.5">
          <span
            aria-hidden
            className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full border border-fd-border font-mono text-[10px] text-fd-muted-foreground"
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] leading-[18px]">
              <Chip tone={step.class}>{step.class}</Chip>
              <span className="text-fd-foreground">{step.kind}</span>
              <span className="text-fd-muted-foreground/70">
                lock {step.lock.toLowerCase()}
                {step.transactional ? "" : " · outside a transaction"}
              </span>
            </p>
            <div className="mt-1">
              <Sql lines={step.lines} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Linter findings, or the word that there are none. */
function Lint({ findings }: { readonly findings: ReadonlyArray<HeroFinding> }): ReactNode {
  if (findings.length === 0) {
    return (
      <p className="font-mono text-[11px] text-fd-muted-foreground">
        no findings, nothing to review
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {findings.map((finding) => (
        <li
          key={`${finding.code}-${finding.step}`}
          className="font-mono text-[11px] leading-[1.6]"
        >
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip tone={finding.severity}>{finding.severity}</Chip>
            <span className="text-fd-foreground">{finding.code}</span>
            <span className="text-fd-muted-foreground">
              step {finding.step}: {finding.message}
            </span>
          </p>
          <p className="mt-0.5 text-fd-muted-foreground/70">fix: {finding.fix}</p>
        </li>
      ))}
    </ul>
  );
}

/** The part of the emitted types that changed. */
function Types({ types }: { readonly types: HeroMigrateView["types"] }): ReactNode {
  if (types === null) {
    return <p className="font-mono text-[11px] text-fd-muted-foreground">unchanged</p>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-fd-border bg-fd-background/60">
      <Diff rows={types.rows} />
      {types.more > 0 ? (
        <p className="border-t border-fd-border px-3 py-1 font-mono text-[10px] text-fd-muted-foreground/60">
          + {types.more} more changed lines
        </p>
      ) : null}
    </div>
  );
}

/** Rules the planner recorded for a statement, with who asked for each. */
function Rules({ rules }: { readonly rules: ReadonlyArray<HeroRule> }): ReactNode {
  return (
    <ul className="flex flex-col gap-1.5 font-mono text-[11px] leading-[1.5]">
      {rules.map((rule, index) => (
        <li key={`${index}:${rule.rule}`} className="flex items-baseline gap-2">
          <span className="w-[5.5rem] shrink-0 text-fd-foreground">{rule.rule}</span>
          <span className="min-w-0 flex-1 text-fd-muted-foreground">{rule.contribution}</span>
          <Chip tone="quiet">{rule.provenance}</Chip>
        </li>
      ))}
    </ul>
  );
}

/** Right column for a schema edit: plan, lint, types. */
function MigrateResult({ scenario }: { readonly scenario: HeroMigrateView }): ReactNode {
  const steps = scenario.plan.steps.length;
  return (
    <>
      <Section
        label="plan"
        trailing={
          <>
            {scenario.plan.file} · {steps} {steps === 1 ? "step" : "steps"} ·{" "}
            <span className="text-fd-foreground">{scenario.plan.class}</span>
          </>
        }
      >
        <Plan steps={scenario.plan.steps} />
      </Section>
      <Section
        label="lint"
        trailing={
          scenario.lint.length === 0 ? (
            <Chip tone="clean">clean</Chip>
          ) : (
            <Chip tone="error">
              {scenario.lint.length} {scenario.lint.length === 1 ? "finding" : "findings"}
            </Chip>
          )
        }
      >
        <Lint findings={scenario.lint} />
      </Section>
      <Section
        label="types"
        trailing={scenario.types === null ? undefined : `.okm/types.d.ts · ${scenario.types.label}`}
      >
        <Types types={scenario.types} />
      </Section>
    </>
  );
}

/** Right column for a call: the SQL, what came back, and the rules behind it. */
function QueryResult({ scenario }: { readonly scenario: HeroQueryView }): ReactNode {
  const { count } = scenario.result;
  const refused = scenario.error !== null && scenario.sql.lines.length === 0;
  const findings =
    scenario.error === null
      ? []
      : [
          {
            severity: "error" as const,
            code: scenario.error.code,
            step: 1,
            message: scenario.error.message,
            fix: scenario.error.fix,
          },
        ];
  const ruleCount = findings.length + scenario.rules.length;
  return (
    <>
      <Section label="sql" trailing={refused ? "refused" : "1 statement"}>
        {refused ? (
          <p className="font-mono text-[11px] text-fd-muted-foreground">no statement</p>
        ) : (
          <>
            <Sql lines={scenario.sql.lines} />
            <p className="mt-1.5 font-mono text-[10.5px] break-all text-fd-muted-foreground/70">
              {scenario.sql.params.map((value, index) => `$${index + 1} = ${value}`).join("  ·  ")}
            </p>
          </>
        )}
      </Section>
      <Section
        label="result"
        trailing={count === null ? undefined : `${count} ${count === 1 ? "row" : "rows"}`}
      >
        <div className="overflow-hidden rounded-md border border-fd-border bg-fd-background/60 px-3 py-2">
          <Sql lines={scenario.result.lines} />
        </div>
      </Section>
      <Section
        label="rules"
        trailing={
          findings.length > 0 ? (
            <Chip tone="error">
              {findings.length} {findings.length === 1 ? "finding" : "findings"}
            </Chip>
          ) : (
            `${ruleCount} on this statement`
          )
        }
      >
        {findings.length > 0 ? <Lint findings={findings} /> : null}
        {scenario.rules.length > 0 ? <Rules rules={scenario.rules} /> : null}
        {findings.length === 0 && scenario.rules.length === 0 ? (
          <p className="font-mono text-[11px] text-fd-muted-foreground">no rules</p>
        ) : null}
      </Section>
    </>
  );
}

/** Square arrow button at the end of the tab bar. */
function PagerButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex w-10 items-center justify-center border-s border-fd-border transition-colors hover:bg-fd-foreground/[0.04] hover:text-fd-foreground focus-visible:bg-fd-foreground/[0.04] focus-visible:text-fd-foreground focus-visible:outline-none active:bg-fd-foreground/[0.08]"
    >
      {children}
    </button>
  );
}

/** A scroll region: thin bar, no scroll chaining into the page, a visible focus ring. */
const SCROLL =
  "overscroll-contain [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fd-ring";

/** Opacity swap for the scenarios stacked in one grid cell. */
function stacked(shown: boolean): string {
  return cn(
    "col-start-1 row-start-1 min-w-0 transition-opacity duration-200",
    shown ? "opacity-100" : "pointer-events-none opacity-0",
  );
}

/**
 * The framed stage: group and feature tabs, the input on the left, what
 * okmodel made of it on the right, and the rail.
 *
 * @param facts - Contract cells for the trailing edge of the rail
 */
export function HeroStage({ facts }: { readonly facts: ReactNode }): ReactNode {
  const { scenarios, index, current, running, select, step, pause } = useHeroWalk();
  const tabsRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const count = scenarios.length;

  // Whether the result pane has more below what is on screen.
  const [more, setMore] = useState(false);
  const measureMore = () => {
    const pane = resultRef.current;
    if (pane !== null) setMore(pane.scrollHeight - pane.scrollTop - pane.clientHeight > 8);
  };

  // A new example starts at its top.
  useEffect(() => {
    codeRef.current?.scrollTo({ top: 0 });
    resultRef.current?.scrollTo({ top: 0 });
    measureMore();
  }, [index]);

  useEffect(() => {
    const pane = resultRef.current;
    if (pane === null) return;
    const observer = new ResizeObserver(measureMore);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  /** Scenarios of the shown group, with their place in the whole walk. */
  const inGroup = useMemo(
    () =>
      scenarios.flatMap((scenario, position) =>
        scenario.group === current.group ? [{ scenario, position }] : [],
      ),
    [scenarios, current.group],
  );
  const groups = useMemo(
    () =>
      HERO_GROUPS.map((group) => ({
        ...group,
        first: scenarios.findIndex((scenario) => scenario.group === group.id),
        size: scenarios.filter((scenario) => scenario.group === group.id).length,
      })),
    [scenarios],
  );

  // Keep the shown tab in view in the strip without moving the page.
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector('[aria-selected="true"]');
    if (strip === null || !(tab instanceof HTMLElement)) return;
    const left = tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [index]);

  const added =
    current.kind === "migrate" ? current.diff.filter((row) => row.mark === "add").length : 0;
  const removed =
    current.kind === "migrate" ? current.diff.filter((row) => row.mark === "del").length : 0;

  return (
    <div
      className="mt-11 w-full overflow-hidden rounded-xl border border-fd-border bg-fd-card/80 text-start shadow-sm backdrop-blur-sm"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") pause(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") pause(false);
      }}
    >
      <div className="relative border-b border-fd-border">
        <div className="flex items-stretch justify-between border-b border-fd-border bg-fd-foreground/[0.02]">
          <div role="tablist" aria-label="Area" className="flex min-w-0 overflow-x-auto [scrollbar-width:none]">
            {groups.map((group) => {
              const selected = group.id === current.group;
              return (
                <button
                  key={group.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => select(group.first)}
                  className={cn(
                    "flex shrink-0 items-center gap-2 border-e border-fd-border px-4 py-2 font-mono text-[10.5px] tracking-[0.14em] uppercase transition-colors",
                    selected
                      ? "text-fd-foreground"
                      : "text-fd-muted-foreground hover:text-fd-foreground/80",
                  )}
                >
                  {group.label}
                  <span className="text-fd-muted-foreground/50 tabular-nums">{group.size}</span>
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-stretch font-mono text-[11px] text-fd-muted-foreground">
            <p className="flex items-center px-3 tabular-nums text-fd-muted-foreground/70">
              {index + 1}
              <span aria-hidden className="mx-0.5 text-fd-muted-foreground/40">
                /
              </span>
              <span className="sr-only"> of </span>
              {count}
            </p>
            <PagerButton label="Previous" onClick={() => step(-1)}>
              <ChevronLeftIcon className="size-3.5" />
            </PagerButton>
            <PagerButton label="Next" onClick={() => step(1)}>
              <ChevronRightIcon className="size-3.5" />
            </PagerButton>
          </div>
        </div>
        <div
          ref={tabsRef}
          role="tablist"
          aria-label={`${HERO_GROUPS.find((group) => group.id === current.group)?.label ?? ""} features`}
          className="flex overflow-x-auto [scrollbar-width:none]"
          onKeyDown={(event) => {
            const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (delta === 0) return;
            event.preventDefault();
            step(delta);
            requestAnimationFrame(() => {
              const next = tabsRef.current?.querySelector('[aria-selected="true"]');
              if (next instanceof HTMLElement) next.focus({ preventScroll: true });
            });
          }}
        >
          {inGroup.map(({ scenario, position }) => {
            const selected = position === index;
            return (
              <button
                key={scenario.id}
                type="button"
                role="tab"
                id={`hero-tab-${scenario.id}`}
                aria-selected={selected}
                aria-controls={`hero-panel-${scenario.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(position)}
                onFocus={() => select(position)}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") select(position);
                }}
                className={cn(
                  "relative flex shrink-0 items-center gap-2 border-e border-fd-border px-4 py-2.5 font-mono text-[11px] tracking-wide whitespace-nowrap transition-colors",
                  selected
                    ? "text-fd-foreground"
                    : "text-fd-muted-foreground hover:bg-fd-foreground/[0.03] hover:text-fd-foreground/80",
                )}
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full transition-opacity"
                  style={{ backgroundColor: toneVar(scenario), opacity: selected ? 1 : 0.35 }}
                />
                {scenario.label}
                {selected ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 -bottom-px h-0.5"
                    style={{ backgroundColor: toneVar(scenario) }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
        {running ? (
          <span
            key={index}
            aria-hidden
            className="okm-progress pointer-events-none absolute inset-x-0 -bottom-px h-px opacity-70"
            style={
              {
                "--okm-walk-ms": `${WALK_MS}ms`,
                backgroundColor: toneVar(current),
              } as CSSProperties
            }
          />
        ) : null}
      </div>

      <div className="grid lg:max-h-[clamp(18rem,calc(100svh-41rem),34rem)] lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col">
          <p className="flex items-center justify-between gap-3 border-b border-fd-border px-4 py-2.5 font-mono text-[11px] text-fd-muted-foreground">
            <span className="flex items-center gap-2">
              <span aria-hidden className="okm-pulse size-1 rounded-full bg-fd-foreground/60" />
              {current.kind === "migrate" ? "schema.ts" : "query.ts"}
            </span>
            {current.kind === "migrate" ? (
              <span className="tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
                <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
              </span>
            ) : (
              <span>{HERO_GROUPS.find((group) => group.id === current.group)?.label.toLowerCase()}</span>
            )}
          </p>
          <div
            ref={codeRef}
            tabIndex={0}
            aria-label="Code"
            className={cn("grid max-h-72 min-h-0 flex-1 overflow-y-auto py-3 lg:max-h-none", SCROLL)}
          >
            {inGroup.map(({ scenario, position }) => (
              <div
                key={scenario.id}
                id={`hero-panel-${scenario.id}`}
                role="tabpanel"
                aria-labelledby={`hero-tab-${scenario.id}`}
                aria-hidden={position !== index}
                inert={position !== index}
                className={cn(stacked(position === index), "overflow-x-auto")}
              >
                <Diff rows={scenario.kind === "migrate" ? scenario.diff : scenario.code} />
              </div>
            ))}
          </div>
          <p
            key={current.id}
            className="okm-fade flex items-center gap-2 border-t border-fd-border px-4 py-2.5 font-mono text-[11px] text-fd-muted-foreground"
          >
            <span aria-hidden className="text-fd-muted-foreground/50 select-none">
              {current.kind === "migrate" ? "$" : "↳"}
            </span>
            <span className="text-fd-foreground/80">
              {current.kind === "migrate"
                ? `okm generate ${current.name}`
                : "real client on PGlite, not a mock"}
            </span>
          </p>
        </div>

        <div className="relative min-h-0 min-w-0 border-t border-fd-border lg:border-s lg:border-t-0">
        <div
          ref={resultRef}
          tabIndex={0}
          aria-label="Result"
          onScroll={measureMore}
          className={cn("max-h-[28rem] overflow-y-auto lg:h-full lg:max-h-none", SCROLL)}
        >
          <div className="grid">
            {inGroup.map(({ scenario, position }) => (
              <div
                key={scenario.id}
                aria-hidden={position !== index}
                inert={position !== index}
                className={stacked(position === index)}
              >
                {scenario.kind === "migrate" ? (
                  <MigrateResult scenario={scenario} />
                ) : (
                  <QueryResult scenario={scenario} />
                )}
              </div>
            ))}
          </div>
        </div>
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-fd-card to-transparent transition-opacity duration-200",
            more ? "opacity-100" : "opacity-0",
          )}
        />
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-fd-border px-4 py-3 font-mono text-[11px] sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p key={current.id} className="okm-fade flex min-w-0 items-baseline gap-2">
          <span
            aria-hidden
            className="size-1 shrink-0 translate-y-[-1px] rounded-full"
            style={{ backgroundColor: toneVar(current) }}
          />
          <span className="min-w-0 text-fd-muted-foreground">{current.note}</span>
          <Link
            href={current.href}
            className="shrink-0 text-fd-muted-foreground/60 underline-offset-2 hover:text-fd-foreground hover:underline"
          >
            docs →
          </Link>
        </p>
        {facts}
      </div>
    </div>
  );
}
