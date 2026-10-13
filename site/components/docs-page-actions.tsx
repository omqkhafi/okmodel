"use client";

/**
 * Docs page toolbar. GitHub and npm sit on the left. Copy page sits on the right.
 */

import { CheckIcon, ChevronIcon, GithubMark, NpmMark } from "@/components/chrome/icons";
import { SITE_ORIGIN } from "@/lib/site-identity";
import { Popover, PopoverContent, PopoverTrigger } from "@fumadocs/base-ui/components/ui/popover";
import { useMemo, useState, type ReactNode } from "react";

/** Props for the docs page toolbar. */
export interface DocsPageActionsProps {
  /** Absolute or site-relative markdown URL for this page. */
  readonly markdownUrl: string;
  /** GitHub blob URL for the canonical source file. */
  readonly githubUrl?: string;
  /** npm page for the package. */
  readonly npmUrl: string;
}

const ITEM =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground";

const MENU_ITEM =
  "text-sm p-2 rounded-lg inline-flex items-center gap-2 hover:text-fd-accent-foreground hover:bg-fd-accent";

/**
 * Prompt the page menu prefills in each assistant.
 *
 * @param markdownUrl - Per-page markdown URL (may be site-relative)
 */
function documentationPrompt(markdownUrl: string): string {
  const absolute =
    markdownUrl.startsWith("http://") || markdownUrl.startsWith("https://")
      ? markdownUrl
      : new URL(markdownUrl, SITE_ORIGIN).href;
  return `Read this documentation page, so I can ask questions about it:\n\n${absolute}`;
}

/**
 * Assistant deeplink with one query parameter.
 *
 * @param base - Scheme and path, without a query string
 * @param key - Query parameter the assistant reads
 * @param value - Prompt text
 */
function assistantHref(base: string, key: string, value: string): string {
  return `${base}?${new URLSearchParams({ [key]: value })}`;
}

/**
 * Source, package, and Copy page.
 *
 * @param props - Links for this page
 */
export function DocsPageActions({ markdownUrl, githubUrl, npmUrl }: DocsPageActionsProps): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-fd-border pb-4">
      <div className="flex flex-wrap items-center gap-1">
        {githubUrl ? (
          <a href={githubUrl} rel="noreferrer noopener" target="_blank" className={ITEM}>
            <GithubMark className="size-3.5" />
            GitHub
          </a>
        ) : null}
        <a href={npmUrl} rel="noreferrer noopener" target="_blank" className={ITEM}>
          <NpmMark className="size-3.5" />
          npm
        </a>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <CopyPageMenu markdownUrl={markdownUrl} />
      </div>
    </div>
  );
}

function CopyPageMenu({ markdownUrl }: { readonly markdownUrl: string }): ReactNode {
  const prompt = useMemo(() => documentationPrompt(markdownUrl), [markdownUrl]);

  return (
    <Popover>
      <PopoverTrigger className="inline-flex items-center gap-1.5 rounded-lg border border-fd-border px-2.5 py-1 text-xs text-fd-foreground data-[popup-open]:bg-fd-accent">
        Copy page
        <ChevronIcon className="size-3.5 text-fd-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="flex min-w-56 flex-col gap-1">
        <CopyItem
          label="Copy Markdown"
          icon={<CopyIcon className="size-4" />}
          text={() => fetch(markdownUrl).then((response) => response.text())}
        />
        <MenuLink href={markdownUrl} title="View Markdown" icon={<MarkdownIcon className="size-4" />} external />
        <MenuLink
          href={assistantHref("https://chat.openai.com/", "q", prompt)}
          title="Open in ChatGPT"
          icon={<ChatGptIcon className="size-4" />}
          external
        />
        <MenuLink
          href={assistantHref("codex://new", "prompt", prompt)}
          title="Open in Codex"
          icon={<CodexIcon className="size-4" />}
        />
        <MenuLink
          href={assistantHref("https://claude.ai/new", "q", prompt)}
          title="Open in Claude"
          icon={<ClaudeIcon className="size-4" />}
          external
        />
        <MenuLink
          href={assistantHref("claude-cli://open", "q", prompt)}
          title="Open in Claude Code"
          icon={<ClaudeCodeIcon className="size-4" />}
        />
        <MenuLink
          href={assistantHref("https://cursor.com/link/prompt", "text", prompt)}
          title="Open in Cursor"
          icon={<CursorIcon className="size-4" />}
          external
        />
      </PopoverContent>
    </Popover>
  );
}

function CopyItem({
  label,
  icon,
  text,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly text: () => Promise<string>;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(await text());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button type="button" onClick={() => void copy()} className={MENU_ITEM}>
      {copied ? <CheckIcon className="size-4" /> : icon}
      {copied ? "Copied" : label}
    </button>
  );
}

function MenuLink({
  href,
  title,
  icon,
  external = false,
}: {
  readonly href: string;
  readonly title: string;
  readonly icon: ReactNode;
  /** Opens http(s) targets in a new tab. App schemes stay in this window. */
  readonly external?: boolean;
}): ReactNode {
  return (
    <a
      href={href}
      rel={external ? "noreferrer noopener" : undefined}
      target={external ? "_blank" : undefined}
      className={MENU_ITEM}
    >
      {icon}
      {title}
    </a>
  );
}

/**
 * Two overlapping pages, the copy mark.
 *
 * @param className - Sizing classes
 */
function CopyIcon({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16 16V18.8C16 19.9201 16 20.4802 15.782 20.908C15.5903 21.2843 15.2843 21.5903 14.908 21.782C14.4802 22 13.9201 22 12.8 22H5.2C4.0799 22 3.51984 22 3.09202 21.782C2.71569 21.5903 2.40973 21.2843 2.21799 20.908C2 20.4802 2 19.9201 2 18.8V11.2C2 10.0799 2 9.51984 2.21799 9.09202C2.40973 8.71569 2.71569 8.40973 3.09202 8.21799C3.51984 8 4.0799 8 5.2 8H8M11.2 16H18.8C19.9201 16 20.4802 16 20.908 15.782C21.2843 15.5903 21.5903 15.2843 21.782 14.908C22 14.4802 22 13.9201 22 12.8V5.2C22 4.0799 22 3.51984 21.782 3.09202C21.5903 2.71569 21.2843 2.40973 20.908 2.21799C20.4802 2 19.9201 2 18.8 2H11.2C10.0799 2 9.51984 2 9.09202 2.21799C8.71569 2.40973 8.40973 2.71569 8.21799 3.09202C8 3.51984 8 4.07989 8 5.2V12.8C8 13.9201 8 14.4802 8.21799 14.908C8.40973 15.2843 8.71569 15.5903 9.09202 15.782C9.51984 16 10.0799 16 11.2 16Z"
      />
    </svg>
  );
}

/**
 * Markdown mark, for View Markdown.
 *
 * @param className - Sizing classes
 */
function MarkdownIcon({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M22.27 19.385H1.73A1.73 1.73 0 0 1 0 17.655V6.345a1.73 1.73 0 0 1 1.73-1.73h20.54A1.73 1.73 0 0 1 24 6.345v11.308a1.73 1.73 0 0 1-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z" />
    </svg>
  );
}

/**
 * ChatGPT blossom.
 *
 * @param className - Sizing classes
 */
function ChatGptIcon({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

/**
 * Codex mark.
 *
 * @param className - Sizing classes
 */
function CodexIcon({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path
        fillRule="evenodd"
        d="M8.086.457a6.105 6.105 0 0 1 3.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 0 0 .107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 0 1-.18 1.631.167.167 0 0 0 .04.155 5.982 5.982 0 0 1 1.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 0 1-2.934 1.851.162.162 0 0 0-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 0 0-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 0 1-2.595-.622 6.058 6.058 0 0 1-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 0 1-.495-1.283 6.11 6.11 0 0 1-.017-3.064.166.166 0 0 0 .008-.074.115.115 0 0 0-.037-.064 5.958 5.958 0 0 1-1.38-2.202 5.196 5.196 0 0 1-.333-1.589 6.915 6.915 0 0 1 .188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 0 0 .087-.087A6.016 6.016 0 0 1 5.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 0 0-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 0 0 1.46.864l1.94-3.272a.849.849 0 0 0 .007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 0 0 0 1.695h4.848a.849.849 0 0 0 0-1.696h-4.848z"
      />
    </svg>
  );
}

/**
 * Claude spark.
 *
 * @param className - Sizing classes
 */
function ClaudeIcon({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/**
 * Claude Code mark.
 *
 * @param className - Sizing classes
 */
function ClaudeCodeIcon({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path
        fillRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      />
    </svg>
  );
}

/**
 * Cursor cube.
 *
 * @param className - Sizing classes
 */
function CursorIcon({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  );
}

