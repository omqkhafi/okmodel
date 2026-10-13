import { DatabaseSupport, databaseSupportFor } from "@/components/database-support";
import { DocsPageActions } from "@/components/docs-page-actions";
import { getMDXComponents } from "@/components/mdx";
import { readRootPackage } from "@/lib/package-meta";
import { getPageImageUrl, getPageMarkdownUrl, source } from "@/lib/source";
import { githubBlobUrl, npmPackageUrl } from "@/lib/shared";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "@fumadocs/base-ui/layouts/docs/page";
import { createRelativeLink } from "@fumadocs/base-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const sourcePath =
    typeof page.data.source === "string" && page.data.source.length > 0
      ? page.data.source
      : `site/content/docs/${page.path}`;
  const pkg = readRootPackage();
  const databases = databaseSupportFor(page.url);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} breadcrumb={{ enabled: false }}>
      <DocsTitle className={databases ? "flex flex-wrap items-center gap-x-3 gap-y-2" : undefined}>
        {page.data.title}
        {databases ? <DatabaseSupport ids={databases} /> : null}
      </DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <DocsPageActions
        markdownUrl={markdownUrl}
        githubUrl={githubBlobUrl(sourcePath)}
        npmUrl={npmPackageUrl(pkg.name)}
      />
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
