import { searchHandbook, type SearchResult } from "@/lib/search-docs";
import Link from "next/link";

/**
 * Server-rendered search. The form submits with GET, so the results are in
 * the HTML without JavaScript.
 *
 * @param query - The `q` parameter. Empty shows the form only.
 */
export function SearchResults({ query }: { readonly query: string }) {
  const results = query.trim().length === 0 ? [] : searchHandbook(query);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-16">
      <h1 className="text-3xl tracking-tight">Search</h1>
      <form action="/search" method="get" className="mt-6 flex gap-2" role="search">
        <label htmlFor="site-search" className="sr-only">
          Search
        </label>
        <input
          id="site-search"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="Search"
          className="w-full border border-fd-border bg-transparent px-3 py-2 text-base outline-none"
        />
        <button type="submit" className="border border-fd-border px-4 py-2 text-sm">
          Search
        </button>
      </form>
      {query.trim().length > 0 && results.length === 0 ? (
        <p className="mt-8 text-sm text-fd-muted-foreground">No results</p>
      ) : null}
      {results.length > 0 ? (
        <ul className="mt-8 flex flex-col gap-4">
          {results.map((hit) => (
            <SearchHit key={hit.url} hit={hit} />
          ))}
        </ul>
      ) : null}
    </main>
  );
}

/**
 * One result: title, section, summary, and the markdown URL.
 *
 * @param hit - Search hit
 */
function SearchHit({ hit }: { readonly hit: SearchResult }) {
  return (
    <li>
      <Link href={hit.url} className="text-base underline-offset-4 hover:underline">
        {hit.title}
      </Link>
      <p className="text-xs text-fd-muted-foreground">
        {hit.section}
        {hit.chip.length > 0 ? ` · ${hit.chip}` : ""}
      </p>
      {hit.summary.length > 0 ? <p className="mt-1 text-sm text-fd-muted-foreground">{hit.summary}</p> : null}
      <a href={hit.markdown} className="mt-1 inline-flex text-xs text-fd-muted-foreground underline-offset-4 hover:underline">
        Markdown
      </a>
    </li>
  );
}
