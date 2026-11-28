"use client";

/**
 * Version chip beside a heading.
 *
 * The glyph is a neutral database mark. The visible text is "PostgreSQL"
 * and the minimum (`15+`, `18+`, `any`). The tooltip is the version table.
 */

import { Database } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { ENGINES } from "@/lib/generated/docs-constants";
import type { EngineRule } from "@/lib/feature-model";
import { tooltipEvent, tooltipOpen, type TooltipEvent, type TooltipState } from "@/lib/support-tooltip";

/**
 * Visible engine name. The map has one engine.
 *
 * @param id - Rule engine id
 * @returns The handbook name
 */
function engineName(id: string): string {
  return id === ENGINES.postgres.id ? ENGINES.postgres.name : id;
}

const CLOSED: TooltipState = { hover: false, focus: false, sticky: false };

/**
 * Chip with hover, focus, and tap state.
 *
 * @param rule - Generated rule for this heading
 */
export function SupportChip({ rule }: { readonly rule: EngineRule }): ReactNode {
  const [state, setState] = useState<TooltipState>(CLOSED);
  const onEvent = (event: TooltipEvent): void => {
    setState((current) => tooltipEvent(current, event));
  };
  return <SupportChipView rule={rule} open={tooltipOpen(state)} onEvent={onEvent} />;
}

/**
 * Chip markup. Tests render this with `open` set directly.
 *
 * @param rule - Generated rule
 * @param open - Whether the version table is shown
 * @param onEvent - Input handler. Omitted in a static render
 */
export function SupportChipView({
  rule,
  open,
  onEvent,
}: {
  readonly rule: EngineRule;
  readonly open: boolean;
  readonly onEvent?: (event: TooltipEvent) => void;
}): ReactNode {
  const tooltipId = useId();
  const name = engineName(rule.engine);
  const send = (event: TooltipEvent) => (): void => {
    onEvent?.(event);
  };
  return (
    <div className="not-prose relative inline-flex align-middle">
      <button
        type="button"
        className="inline-flex min-h-6.5 items-center gap-1 rounded-full border border-fd-border bg-fd-secondary px-2 py-1 text-sm font-normal leading-none text-fd-foreground"
        aria-expanded={open}
        aria-controls={open ? tooltipId : undefined}
        aria-describedby={open ? tooltipId : undefined}
        onPointerEnter={send("enter")}
        onPointerLeave={send("leave")}
        onFocus={send("focus")}
        onBlur={send("blur")}
        onClick={send("tap")}
      >
        <Database className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{`${name} ${rule.label}`}</span>
      </button>
      {open ? (
        <div
          id={tooltipId}
          role="tooltip"
          className="absolute start-0 top-full z-20 mt-1 w-80 rounded-md border border-fd-border bg-fd-background p-2 text-sm text-fd-foreground shadow-md"
        >
          <VersionTable rule={rule} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Version table for one rule. Words carry the state. Colour does not.
 *
 * @param rule - Generated rule
 */
function VersionTable({ rule }: { readonly rule: EngineRule }): ReactNode {
  return (
    <div>
      <table className="w-full border-collapse text-start">
        <caption className="mb-1 text-start font-medium">
          {rule.docsOnly
            ? `${engineName(rule.engine)}, docs only, no proof`
            : `${engineName(rule.engine)} ${rule.label}`}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="px-1 py-0.5 text-start font-medium">
              Version
            </th>
            <th scope="col" className="px-1 py-0.5 text-start font-medium">
              Available
            </th>
            <th scope="col" className="px-1 py-0.5 text-start font-medium">
              Tested
            </th>
            <th scope="col" className="px-1 py-0.5 text-start font-medium">
              Note
            </th>
          </tr>
        </thead>
        <tbody>
          {rule.versions.map((row) => (
            <tr key={row.version}>
              <th scope="row" className="px-1 py-0.5 text-start font-normal">
                {row.version}
              </th>
              <td className="px-1 py-0.5">{row.available ? "yes" : "no"}</td>
              <td className="px-1 py-0.5">{row.tested ? "tested" : "not tested"}</td>
              <td className="px-1 py-0.5">{row.note.length > 0 ? row.note : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1">{rule.line}</p>
    </div>
  );
}
