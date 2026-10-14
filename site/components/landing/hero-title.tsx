/**
 * Hero title and calls to action. Layout follows better-auth's
 * `docs/components/landing/hero-title.tsx` under the MIT License.
 * Copyright (c) 2024 - present, Bereket Engida. See site/NOTICE.
 * Copy and links are OKModel's. The settle-in is CSS, not an animation library.
 */

"use client";

import { ArrowRightIcon, CheckIcon, ClipboardIcon } from "@/components/chrome/icons";
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { HERO_HEADLINE_LINES, HERO_PILL, HERO_SUBHEAD } from "@/lib/hero-copy";

/** Settle-in step. Each block starts this much after the one above it. */
const STEP_MS = 80;

function settle(index: number): CSSProperties {
  return { "--settle-delay": `${index * STEP_MS}ms` } as CSSProperties;
}

/**
 * @param command - Install command the copy button writes to the clipboard
 */
export function HeroTitle({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-col items-center">
      <div className="okm-settle" style={settle(0)}>
        <Link
          href="/docs/define/schema"
          className="group inline-flex w-fit items-center rounded-full border border-fd-border bg-fd-card px-4 py-1.5 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-secondary/60"
        >
          <span className="font-medium text-fd-foreground">{HERO_PILL}</span>
          <ArrowRightIcon
            className="size-3 w-0 opacity-0 transition-[width,opacity,transform,margin] duration-200 group-hover:ml-1.5 group-hover:w-3 group-hover:translate-x-0.5 group-hover:opacity-100"
          />
        </Link>
      </div>

      <h1 className="pt-6 text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl xl:text-7xl">
        <span className="sr-only">{HERO_HEADLINE_LINES.join(" ")}</span>
        <span aria-hidden className="flex flex-col items-center">
          {HERO_HEADLINE_LINES.map((line, index) => (
            <span key={line} className="okm-settle block" style={settle(index + 1)}>
              {line}
            </span>
          ))}
        </span>
      </h1>

      <p
        className="okm-settle max-w-2xl pt-5 text-sm leading-relaxed text-pretty text-fd-muted-foreground sm:text-base"
        style={settle(3)}
      >
        {HERO_SUBHEAD}
      </p>

      <div
        className="okm-settle flex flex-col items-stretch gap-3 pt-7 sm:flex-row sm:gap-2.5"
        style={settle(4)}
      >
        <Link
          href="/docs/start"
          className="group inline-flex h-10 shrink-0 items-center justify-center rounded-md border border-transparent bg-fd-foreground px-5 text-sm leading-none font-medium text-fd-background transition-opacity hover:opacity-90"
        >
          Let&apos;s start
          <ArrowRightIcon className="ml-2 size-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
        </Link>

        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Install command copied" : `Copy ${command}`}
          className="group inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-fd-border bg-fd-card px-5 font-mono text-sm leading-none text-fd-muted-foreground transition-colors hover:bg-fd-secondary/60"
        >
          <span aria-hidden className="text-fd-muted-foreground/60 select-none">
            $
          </span>
          <span className="text-fd-foreground">{command}</span>
          {copied ? (
            <CheckIcon className="size-3.5 text-fd-foreground" />
          ) : (
            <ClipboardIcon
              className="size-3.5 text-fd-muted-foreground/60 transition-colors group-hover:text-fd-foreground"
            />
          )}
        </button>
      </div>
    </div>
  );
}
