"use client";

import { useEffect, useState, type SVGProps } from "react";

import { cn } from "@/lib/cn";

export type OkmLogoLetter = "O" | "K" | "M";

export const OKM_LOGO_LETTERS: Record<OkmLogoLetter, { width: number; height: number; d: string }> =
  {
    O: {
      width: 88.831,
      height: 79.502,
      d: "M75.93 78.029C72.735 79.011 68.835 79.502 64.224 79.502L24.743 79.502C18.431 79.502 13.478 78.598 9.87 76.798C6.262 74.997 3.693 72.293 2.163 68.685C0.719 65.078 0 60.616 0 55.3L0 24.067C0 18.837 0.719 14.467 2.163 10.952C3.608 7.344 6.127 4.64 9.735 2.839C13.343 0.946 18.346 0 24.743 0L64.224 0C68.892 0 72.791 0.519 75.93 1.551L75.93 15.905L88.07 15.905C88.575 18.346 88.831 21.064 88.831 24.067L88.831 55.3C88.831 59.043 88.44 62.366 87.657 65.27L75.93 65.27L75.93 78.029ZM28.664 66.522L60.438 66.522C63.775 66.522 66.344 65.668 68.145 63.953C70.037 62.238 70.984 59.897 70.984 56.922L70.984 22.444C70.984 19.833 70.037 17.62 68.145 15.819C66.252 13.926 63.683 12.98 60.438 12.98L28.664 12.98C25.419 12.98 22.807 13.834 20.822 15.549C18.837 17.264 17.847 19.562 17.847 22.444L17.847 56.922C17.847 59.989 18.794 62.373 20.687 64.088C22.672 65.711 25.326 66.522 28.664 66.522Z",
    },
    K: {
      width: 94.375,
      height: 80.854,
      d: "M17.847 15.905L17.847 34.613L25.419 34.613C27.219 34.613 28.707 34.385 29.881 33.937C31.048 33.489 32.13 32.763 33.126 31.774C35.645 29.248 38.534 26.095 41.779 22.309C45.024 18.523 48.177 14.645 51.244 10.681C54.396 6.625 57.1 3.067 59.356 0L81.26 0L75.716 8.112C73.19 10.724 70.486 13.563 67.604 16.631L59.086 25.689C56.289 28.571 53.763 31.14 51.514 33.396C49.258 35.56 47.593 37.139 46.511 38.129C48.945 38.94 51.151 39.979 53.137 41.238C55.207 42.498 57.734 44.348 60.708 46.782C62.957 48.582 65.12 50.432 67.198 52.325C69.361 54.218 71.838 56.474 74.635 59.086C77.787 61.968 80.762 64.088 83.558 65.44C86.348 66.793 88.696 67.646 90.589 68.009C92.567 68.372 93.834 68.55 94.375 68.55L91.671 79.502C91.4 79.772 90.589 80.043 89.237 80.313C87.885 80.676 85.942 80.854 83.423 80.854C79.004 80.854 75.175 79.95 71.93 78.15C68.685 76.35 65.483 73.916 62.331 70.849C58.901 67.241 54.759 63.099 49.892 58.41C47.636 56.068 45.337 54.126 42.996 52.596C40.648 51.066 37.993 49.892 35.019 49.08C32.13 48.269 28.529 47.863 24.202 47.863L17.847 47.863L17.847 65.27L0 65.27L0 15.905L17.847 15.905Z",
    },
    M: {
      width: 101,
      height: 79.502,
      d: "M83.153 65.49L83.153 29.07L81.665 29.07L76.392 40.833L59.356 71.39L42.996 71.39L25.96 40.833L20.552 29.07L19.199 29.07L19.199 79.502L1.352 79.502L1.352 10.817L0 0L20.552 0L51.108 54.083L73.574 15.677L101 15.684L101 65.49L83.153 65.49Z",
    },
  };

const CYCLE: OkmLogoLetter[] = ["O", "K", "M"];
const CANVAS = 96;
const PAD = 14;
const CONTENT = CANVAS - PAD * 2;
const MAX_W = 101;
const MAX_H = 87;
const SCALE = Math.min(CONTENT / MAX_W, CONTENT / MAX_H);
/** Soft blur morph duration (ms). */
const FADE_MS = 560;
const FAVICON_FADE_STEPS = 10;
const MAX_BLUR = 7;
const MIN_SCALE = 0.92;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Bell curve: 0 at ends, 1 at midpoint. */
function peak(t: number): number {
  return Math.sin(Math.PI * t);
}

function letterTransform(letter: OkmLogoLetter, scaleMul = 1): string {
  const { width, height } = OKM_LOGO_LETTERS[letter];
  const s = SCALE * scaleMul;
  const w = width * s;
  const h = height * s;
  const x = (CANVAS - w) / 2;
  const y = (CANVAS - h) / 2;
  return `translate(${x} ${y}) scale(${s})`;
}

function letterGroup(letter: OkmLogoLetter, opacity: number, scaleMul = 1, filter?: string): string {
  const { d } = OKM_LOGO_LETTERS[letter];
  const filterAttr = filter ? ` filter="${filter}"` : "";
  return `<g opacity="${opacity.toFixed(3)}"${filterAttr} transform="${letterTransform(letter, scaleMul)}"><path d="${d}" fill="#FFFFFF"/></g>`;
}

function markShell(inner: string, blur = 0): string {
  const filter =
    blur > 0.05
      ? `<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blur.toFixed(2)}"/></filter>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none"><defs><clipPath id="c"><rect width="${CANVAS}" height="${CANVAS}" rx="20"/></clipPath>${filter}</defs><rect width="${CANVAS}" height="${CANVAS}" rx="20" fill="#0D0D0D"/><g clip-path="url(#c)">${inner}</g></svg>`;
}

/** SVG mark markup for a single letter (favicon / data-URL). */
export function okmLogoMarkSvg(letter: OkmLogoLetter, opacity = 1): string {
  return markShell(letterGroup(letter, opacity));
}

/**
 * Soft morph frame between two letters.
 * `t` is 0 (from) → 1 (to): crossfade + mid-peak blur + slight scale pulse.
 */
export function okmLogoMarkCrossfadeSvg(from: OkmLogoLetter, to: OkmLogoLetter, t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const e = easeInOutCubic(clamped);
  const p = peak(clamped);
  const blur = MAX_BLUR * p;
  const scaleMul = 1 - (1 - MIN_SCALE) * p;
  const filter = blur > 0.05 ? "url(#b)" : undefined;

  return markShell(
    `${letterGroup(from, 1 - e, scaleMul, filter)}${letterGroup(to, e, scaleMul, filter)}`,
    blur,
  );
}

export type OkmLogoIconProps = SVGProps<SVGSVGElement> & {
  /** Which letter to show. Ignored when `animated` is true. */
  letter?: OkmLogoLetter;
  /** Cycle O → K → M with a blurred morph. */
  animated?: boolean;
  /** Hold time per letter in ms. Default 1500. */
  intervalMs?: number;
};

/**
 * OKM logo mark — single letter in the rounded brand square.
 *
 * Paths from `site/public/okm.svg`, scaled into the same 101×87 box the
 * blur uses. White letter on `#0D0D0D`.
 */
export function OkmLogoIcon({
  letter = "O",
  animated = false,
  intervalMs = 1500,
  className,
  ...props
}: OkmLogoIconProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!animated) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % CYCLE.length);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [animated, intervalMs]);

  const active = animated ? CYCLE[index]! : letter;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${CANVAS} ${CANVAS}`}
      fill="none"
      role="img"
      aria-label="OKM"
      className={cn("size-8 overflow-hidden rounded-[20.8%]", className)}
      {...props}
    >
      <rect width={CANVAS} height={CANVAS} rx="20" fill="#0D0D0D" />
      {(animated ? CYCLE : [active]).map((L) => {
        const { d } = OKM_LOGO_LETTERS[L];
        const on = L === active;
        return (
          <g
            key={L}
            transform={letterTransform(L)}
            style={{
              opacity: on ? 1 : 0,
              filter: on ? "blur(0px)" : `blur(${MAX_BLUR}px)`,
              transition: [
                `opacity ${FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
                `filter ${FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
              ].join(", "),
            }}
          >
            <path d={d} fill="#FFFFFF" />
          </g>
        );
      })}
    </svg>
  );
}

function setFaviconHref(href: string) {
  let link = document.querySelector<HTMLLinkElement>("link[data-okm-favicon-cycle]");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.dataset.okmFaviconCycle = "";
    document.head.appendChild(link);
  }
  link.href = href;
}

/**
 * Cycles the document favicon through O → K → M every `intervalMs`,
 * with a blurred soft-morph between letters.
 *
 * Mount once in the root layout.
 */
export function OkmFaviconCycle({ intervalMs = 1500 }: { intervalMs?: number }) {
  useEffect(() => {
    let i = 0;
    let cancelled = false;
    let objectUrl: string | null = null;
    const timers: number[] = [];

    const later = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(fn, ms));
    };

    const paint = (svg: string) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setFaviconHref(objectUrl);
    };

    const holdMs = Math.max(intervalMs - FADE_MS, 200);

    const runCycle = () => {
      if (cancelled) return;
      const from = CYCLE[i]!;
      const to = CYCLE[(i + 1) % CYCLE.length]!;

      paint(okmLogoMarkSvg(from));

      later(() => {
        if (cancelled) return;
        const stepMs = FADE_MS / FAVICON_FADE_STEPS;
        for (let s = 1; s <= FAVICON_FADE_STEPS; s++) {
          const t = s / FAVICON_FADE_STEPS;
          later(() => {
            if (cancelled) return;
            paint(okmLogoMarkCrossfadeSvg(from, to, t));
            if (s === FAVICON_FADE_STEPS) {
              i = (i + 1) % CYCLE.length;
              later(runCycle, 0);
            }
          }, s * stepMs);
        }
      }, holdMs);
    };

    runCycle();

    return () => {
      cancelled = true;
      for (const id of timers) window.clearTimeout(id);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [intervalMs]);

  return null;
}
