"use client";

import { searchHits, searchSnippet } from "@/lib/search-snippet";
import { searchKeyAction } from "@/lib/search-keys";
import { useDocsSearch } from "fumadocs-core/search/client";
import { fetchClient } from "fumadocs-core/search/client/fetch";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Search dialog props passed by the Fumadocs provider.
 */
interface SearchDialogProps {
  /** Whether the dialog is open. */
  readonly open: boolean;
  /** Open or close the dialog. */
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Handbook search. Results come from `/api/search`. The dialog does not
 * ship the static index or a markdown parser; excerpts keep `<mark>` only.
 *
 * @param props - Open state from the site provider
 */
export default function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const router = useRouter();
  const { search, setSearch, query } = useDocsSearch({ client: fetchClient() });
  const hits = searchHits(query.data);
  const [active, setActive] = useState(0);
  const index = hits.length === 0 ? 0 : Math.min(active, hits.length - 1);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-fd-background/70 px-4 pt-[12vh]"
      onMouseDown={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="w-full max-w-xl border border-fd-border bg-fd-background"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={search}
          placeholder="Search"
          aria-label="Search"
          aria-controls="site-search-results"
          aria-activedescendant={hits[index] ? `site-search-${String(index)}` : undefined}
          onChange={(event) => {
            setSearch(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            const action = searchKeyAction(event.key, index, hits.length);
            if (action.type === "none") return;
            event.preventDefault();
            if (action.type === "close") onOpenChange(false);
            if (action.type === "move") setActive(action.index);
            if (action.type === "select") {
              const hit = hits[index];
              if (hit === undefined) return;
              onOpenChange(false);
              router.push(hit.url);
            }
          }}
          className="w-full border-b border-fd-border bg-transparent px-4 py-3 text-base outline-none placeholder:text-fd-muted-foreground"
        />
        <ul id="site-search-results" role="listbox" aria-label="Search results" className="max-h-80 overflow-y-auto">
          {query.isLoading ? <li className="px-4 py-3 text-sm text-fd-muted-foreground">Searching</li> : null}
          {!query.isLoading && search.length > 0 && hits.length === 0 ? (
            <li className="px-4 py-3 text-sm text-fd-muted-foreground">No results</li>
          ) : null}
          {hits.map((hit, hitIndex) => (
            <li key={hit.id} role="option" id={`site-search-${String(hitIndex)}`} aria-selected={hitIndex === index}>
              <a
                href={hit.url}
                onClick={() => onOpenChange(false)}
                className={
                  hitIndex === index
                    ? "block bg-fd-foreground/5 px-4 py-2 text-sm text-fd-foreground"
                    : "block px-4 py-2 text-sm text-fd-muted-foreground"
                }
              >
                {searchSnippet(hit.content).map((part, partIndex) =>
                  part.mark ? (
                    <mark key={partIndex} className="bg-transparent text-fd-foreground underline">
                      {part.text}
                    </mark>
                  ) : (
                    <span key={partIndex}>{part.text}</span>
                  ),
                )}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
