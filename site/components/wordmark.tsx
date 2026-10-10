/**
 * Text wordmark. The name comes from site identity, not a drawn logo.
 */

import { SITE_NAME } from "@/lib/site-identity";

/**
 * @param className - Extra classes
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ?? "font-mono text-sm tracking-[0.16em] uppercase"}>
      {SITE_NAME}
    </span>
  );
}
