import { JsonLd } from "@/components/json-ld";
import { readTagline, readmeInstallSnippet, softwareApplicationJsonLd } from "@/lib/package-meta";
import { SITE_NAME } from "@/lib/site-identity";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    images: ["/og/home"],
  },
};

/**
 * Placeholder homepage. The designed homepage is a later step.
 */
export default function HomePage() {
  const install = readmeInstallSnippet();
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-24">
      <JsonLd data={softwareApplicationJsonLd()} />
      <h1 className="text-4xl tracking-tight">{SITE_NAME}</h1>
      <p className="mt-4 text-lg leading-relaxed text-fd-muted-foreground">{readTagline()}</p>
      <pre className="mt-8 overflow-x-auto border border-fd-border bg-fd-card p-4 font-mono text-sm">
        <code>{install}</code>
      </pre>
      <p className="mt-8">
        <Link
          href="/docs"
          className="inline-flex border border-fd-border px-4 py-2 text-sm hover:bg-fd-accent"
        >
          Read the docs
        </Link>
      </p>
    </main>
  );
}
