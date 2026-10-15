import localFont from "next/font/local";
import { Provider } from "@/components/provider";
import { Topbar } from "@/components/chrome/topbar";
import { ScrollToTop } from "@/components/scroll-to-top";
import { readTagline } from "@/lib/package-meta";
import { SITE_NAME, SITE_ORIGIN } from "@/lib/site-identity";
import { source } from "@/lib/source";
import { WEBMCP_GUARD } from "@/lib/webmcp-guard";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./global.css";

const ibmPlexSans = localFont({
  src: [
    {
      path: "./fonts/IBMPlexSansVar-Roman.woff2",
      weight: "100 700",
      style: "normal",
    },
    {
      path: "./fonts/IBMPlexSansVar-Italic.woff2",
      weight: "100 700",
      style: "italic",
    },
  ],
  display: "optional",
  adjustFontFallback: "Arial",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
  preload: true,
  declarations: [{ prop: "font-stretch", value: "100%" }],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description: readTagline(),
  robots: { index: true, follow: true },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

/**
 * Site shell. The header stays mounted so the docs and changelog panes
 * share one bar. Page content is server-rendered and readable without
 * JavaScript.
 *
 * @param children - The active route
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={ibmPlexSans.className} suppressHydrationWarning>
      <head>
        <link rel="describedby" type="text/markdown" href="/llms.txt" title="Site index for LLMs" />
        <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
        <link rel="agent-skills" type="application/json" href="/.well-known/agent-skills/index.json" />
      </head>
      <body className="flex min-h-screen flex-col">
        <a href="#content" className="skip-link">
          Skip to content
        </a>
        <Provider>
          <ScrollToTop />
          <Topbar tree={source.getPageTree()} />
          <div id="content" className="flex flex-1 flex-col">
            {children}
          </div>
        </Provider>
        <script dangerouslySetInnerHTML={{ __html: WEBMCP_GUARD }} />
      </body>
    </html>
  );
}
