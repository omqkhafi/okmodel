import { SearchResults } from "@/components/search-results";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Search",
  description: "Search the handbook.",
  robots: { index: false, follow: true },
};

/**
 * Handbook search. `?q=` is rendered on the server.
 *
 * @param props - Next page props
 */
export default async function Page(props: PageProps<"/search">): Promise<ReactNode> {
  const params = await props.searchParams;
  const raw = params.q;
  const query = typeof raw === "string" ? raw : "";
  return <SearchResults query={query} />;
}
