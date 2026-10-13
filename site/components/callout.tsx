/**
 * Dashed note on a docs page. The left edge and icon follow the tone.
 */

import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Tone of a callout. `warn` is `warning`. */
export type CalloutType = "info" | "warning" | "error" | "success" | "warn";

/** One tone: the start border and the filled icon. */
interface CalloutTone {
  readonly edge: string;
  readonly mark: string;
  readonly Icon: LucideIcon;
}

const TONES: Record<Exclude<CalloutType, "warn">, CalloutTone> = {
  info: {
    edge: "border-s-blue-500/50",
    mark: "fill-blue-500 text-fd-card",
    Icon: Info,
  },
  warning: {
    edge: "border-s-amber-500/50",
    mark: "fill-amber-500 text-fd-card",
    Icon: TriangleAlert,
  },
  error: {
    edge: "border-s-red-500/50",
    mark: "fill-red-500 text-fd-card",
    Icon: CircleX,
  },
  success: {
    edge: "border-s-green-500/50",
    mark: "fill-green-500 text-fd-card",
    Icon: CircleCheck,
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
  const Icon = tone.Icon;
  return (
    <div
      className={cn(
        "my-4 flex items-start gap-2 rounded-none border border-s-2 border-dashed bg-fd-card p-3 text-sm text-fd-card-foreground shadow-md",
        tone.edge,
      )}
    >
      <Icon className={cn("size-5 shrink-0", tone.mark)} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1 [&_p]:my-0">
        {title != null ? <p className="font-medium">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
