/**
 * Contract cells for the hero rail: what the package promises and the version
 * it is at. Each claim is gated against the README by `hero.site-test.ts`.
 */

import { HERO_CONTRACT } from "@/lib/hero";
import { readRootPackage } from "@/lib/package-meta";

/**
 * Trailing edge of the hero rail.
 */
export function HeroFacts() {
  const cells = [...HERO_CONTRACT, `v${readRootPackage().version}`];
  return (
    <p className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-fd-muted-foreground/60">
      {cells.map((cell, index) => (
        <span key={cell} className="inline-flex items-center gap-2">
          {index > 0 ? <span aria-hidden>·</span> : null}
          <span className={index === cells.length - 1 ? "tabular-nums" : undefined}>{cell}</span>
        </span>
      ))}
    </p>
  );
}
