import type { Metadata } from "next";
import { NotFoundView } from "@/components/not-found/not-found-view";

export const metadata: Metadata = {
  title: "Not found",
  description: "No page matched this path.",
  robots: { index: false, follow: true },
};

/**
 * Unknown URLs and `notFound()` from route segments.
 */
export default function NotFound() {
  return <NotFoundView />;
}
