/**
 * Dashed note on a docs page. The left edge and icon follow the tone.
 * Marks are inline so the docs shell does not import an icon package.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Tone of a callout. `warn` is `warning`. */
export type CalloutType = "info" | "warning" | "error" | "success" | "warn";

/** One tone: the start border and the filled icon. */
interface CalloutTone {
  readonly edge: string;
  readonly mark: string;
  readonly icon: "info" | "warning" | "error" | "success";
}

const TONES: Record<Exclude<CalloutType, "warn">, CalloutTone> = {
  info: {
    edge: "border-s-blue-500/50",
    mark: "fill-blue-500 text-fd-card",
    icon: "info",
  },
  warning: {
    edge: "border-s-amber-500/50",
    mark: "fill-amber-500 text-fd-card",
    icon: "warning",
  },
  error: {
    edge: "border-s-red-500/50",
    mark: "fill-red-500 text-fd-card",
    icon: "error",
  },
  success: {
    edge: "border-s-green-500/50",
    mark: "fill-green-500 text-fd-card",
    icon: "success",
  },
};

/**
 * A dashed card. `info` is blue, `warning` is amber, `error` is red, and `success` is green.
 *
 * @param props - Tone, optional title, and the note
 */
export function Callout({
  type = "info",
  title,
  children,
}: {
  readonly type?: CalloutType;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  const tone = TONES[type === "warn" ? "warning" : type];
  return (
    <div
      className={cn(
        "my-4 flex items-start gap-2 rounded-none border border-s-2 border-dashed bg-fd-card p-3 text-sm text-fd-card-foreground shadow-md",
        tone.edge,
      )}
    >
      <CalloutMark name={tone.icon} className={cn("size-5 shrink-0", tone.mark)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 [&_p]:my-0">
        {title != null ? <p className="font-medium">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

/**
 * Filled mark for one tone. Paths follow the Lucide 24×24 outlines.
 *
 * @param name - Tone mark
 * @param className - Size and colour
 */
function CalloutMark({ name, className }: { readonly name: CalloutTone["icon"]; readonly className: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {name === "info" ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </>
      ) : null}
      {name === "warning" ? (
        <>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </>
      ) : null}
      {name === "error" ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m15 9-6 6" />
          <path d="m9 9 6 6" />
        </>
      ) : null}
      {name === "success" ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </>
      ) : null}
    </svg>
  );
}
