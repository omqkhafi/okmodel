/**
 * Homepage shell layout adapted from better-auth/better-auth `docs/app/page.tsx`
 * under the MIT License. Copyright (c) 2024 - present, Bereket Engida.
 * See site/NOTICE. Brand art, Trusted By, Ask AI, and sign-in demos omitted;
 * the stage is OKModel's own: a schema edit and what okmodel does with it.
 */

import { HeroFacts } from "@/components/landing/hero-facts";
import { HeroPrism, HeroStage, HeroWalkProvider } from "@/components/landing/hero-stage";
import { HeroTitle } from "@/components/landing/hero-title";
import { JsonLd } from "@/components/json-ld";
import { loadHeroScenarios } from "@/lib/hero-code";
import { readRootPackage, softwareApplicationJsonLd } from "@/lib/package-meta";
import type { Metadata } from "next";

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
    types: { "text/markdown": "/llms.mdx/home" },
  },
  openGraph: {
    images: ["/og/home"],
  },
};

/**
 * Marketing homepage, hero only: copy on top, then one stage that edits a
 * schema and shows what okmodel does with the edit: the safe migration, the
 * lint, and the types. The learning path lives under `/docs`.
 */
export default async function HomePage() {
  const scenarios = await loadHeroScenarios();
  const install = `bun add ${readRootPackage().name}`;

  return (
    <div id="hero" className="relative text-fd-foreground">
      <JsonLd data={softwareApplicationJsonLd()} />
      {/* Clipped: the prism and the grid bleed past the column padding. */}
      <section className="relative flex min-h-[calc(100svh-var(--landing-topbar-height))] flex-col overflow-x-clip border-b border-fd-border">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-grid-black/[0.02] [mask-image:radial-gradient(70%_55%_at_50%_28%,#000,transparent)] dark:bg-grid-white/[0.02]"
        />
        <HeroWalkProvider scenarios={scenarios}>
          <HeroPrism />
          <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-5 py-12 text-center sm:px-8">
            <HeroTitle command={install} />
            <HeroStage facts={<HeroFacts />} />
          </div>
        </HeroWalkProvider>
      </section>
    </div>
  );
}
