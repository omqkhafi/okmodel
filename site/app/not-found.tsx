import type { Metadata } from "next";

import { NotFoundView } from "@/components/not-found/not-found-view";

export const metadata: Metadata = {
  title: "Not found",
  description: "No page matched this path.",
  robots: { index: false, follow: true },
};

/**
 * Static 404 for `notFound()` inside a page. Unknown handbook URLs are
 * rewritten to `/missing` before they reach this page, so the suggestions
 * stay on a route that is allowed to read the request.
 */
export default function NotFound() {
  return <NotFoundView />;
}
