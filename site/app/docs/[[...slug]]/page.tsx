import { DatabaseSupport, databaseSupportFor } from "@/components/database-support";
import { DocsPageActions } from "@/components/docs-page-actions";
import { getMDXComponents } from "@/components/mdx";
import { breadcrumbItems, pageNeighbours } from "@/lib/page-chrome";
import { githubBlobUrl } from "@/lib/shared";
import { getPageImageUrl, getPageMarkdownUrl, source } from "@/lib/source";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "@fumadocs/base-ui/layouts/docs/page";
import { createRelativeLink } from "@fumadocs/base-ui/mdx";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * Only paths from `generateStaticParams` are served. Unknown `/docs/*` used
 * to hit on-demand generation, throw Next's `NoFallbackError`, and surface as
 * HTTP 500 on Vercel (`x-matched-path: /500`).
 */
export const dynamicParams = false;

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const databases = databaseSupportFor(page.url);
  const trail = breadcrumbItems(page.url);
  const neighbours = pageNeighbours(page.url);
  const editHref = githubBlobUrl(`site/content/docs/${page.path}`);

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      breadcrumb={{ enabled: false }}
      footer={{
        enabled: true,
        items: {
          previous: neighbours.previous,
          next: neighbours.next,
        },
      }}
    >
      {trail.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-4 flex flex-wrap items-center gap-1.5 text-sm text-fd-muted-foreground">
          {trail.map((crumb, index) => (
            <span key={`${crumb.name}-${String(index)}`} className="inline-flex items-center gap-1.5">
              {index > 0 ? <span aria-hidden>/</span> : null}
              {crumb.url !== undefined && index < trail.length - 1 ? (
                <Link href={crumb.url} className="hover:text-fd-foreground">
                  {crumb.name}
                </Link>
              ) : (
                <span className={index === trail.length - 1 ? "text-fd-foreground" : undefined}>{crumb.name}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <header className="border-b border-fd-border pb-4">
        <DocsTitle className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {page.data.title}
          {databases ? <DatabaseSupport ids={databases} /> : null}
          <DocsPageActions markdownUrl={markdownUrl} className={databases ? undefined : "ms-auto"} />
        </DocsTitle>
        <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
        <a href={editHref} className="mt-3 inline-flex text-sm text-fd-muted-foreground underline-offset-4 hover:underline">
          Edit on GitHub
        </a>
      </header>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const markdownUrl = getPageMarkdownUrl(page).url;

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: {
        "text/markdown": markdownUrl,
      },
    },
    openGraph: {
      images: getPageImageUrl(page).url,
    },
  };
}
