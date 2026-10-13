import { JsonLd } from "@/components/json-ld";
import { readRootPackage, readTagline, softwareApplicationJsonLd } from "@/lib/package-meta";
import { SITE_NAME } from "@/lib/site-identity";
import { githubRepoUrl } from "@/lib/shared";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    images: ["/og/home"],
  },
};

const STEPS = [
  { href: "/docs/start/install", kicker: "01", title: "Install", text: "Add okmodel and one Postgres driver." },
  { href: "/docs/start/query", kicker: "01", title: "Let's start", text: "Define the table, the schema, and the config, then read the row back." },
] as const;

/**
 * Entry to the handbook. The learning path lives under `/docs`.
 */
export default function HomePage() {
  const install = `bun add ${readRootPackage().name}`;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center px-6 py-24 text-center">
      <JsonLd data={softwareApplicationJsonLd()} />
      <p className="rounded-full border border-fd-border px-3 py-1 font-mono text-xs text-fd-muted-foreground">
        {SITE_NAME}
      </p>
      <h1 className="mt-6 max-w-xl text-5xl tracking-tight sm:text-6xl">The schema is the source.</h1>
      <p className="mt-5 max-w-lg text-lg leading-relaxed text-fd-muted-foreground">{readTagline()}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/docs/start/install"
          className="inline-flex bg-fd-foreground px-4 py-2 text-sm text-fd-background"
        >
          Start
        </Link>
        <Link href="/docs" className="inline-flex border border-fd-border px-4 py-2 text-sm">
          Documentation
        </Link>
        <a
          href={githubRepoUrl}
          className="inline-flex px-4 py-2 text-sm text-fd-muted-foreground"
        >
          GitHub
        </a>
      </div>
      <pre className="mt-12 w-full max-w-xl overflow-x-auto border border-fd-border bg-fd-card p-5 text-left font-mono text-sm">
        <code>{install}</code>
      </pre>
      <ul className="mt-12 grid w-full gap-4 text-left sm:grid-cols-2">
        {STEPS.map((step) => (
          <li key={step.href} className="border border-fd-border p-4">
            <p className="font-mono text-xs text-fd-muted-foreground">{step.kicker}</p>
            <Link href={step.href} className="mt-1 block font-medium">
              {step.title}
            </Link>
            <p className="mt-1 text-sm text-fd-muted-foreground">{step.text}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
