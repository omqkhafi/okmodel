/**
 * Public URLs for one registry code.
 *
 * `/docs/reference/errors/OKM1101.md` is the markdown twin. The extensionless
 * path is the same document when `Accept` prefers markdown. This module stays
 * free of the handbook corpus so the proxy can import it.
 */

const CODE_PATH = /^\/docs\/reference\/errors\/(okm\d{4})(\.md)?$/i;

/** A code path, or `undefined` when this URL is not one code. */
export type ErrorCodePath = {
  /** Normalized `OKM####`. */
  readonly code: string;
  /** The URL already ends in `.md`. */
  readonly markdownFile: boolean;
};

/**
 * Parse `/docs/reference/errors/OKM####` and the `.md` twin.
 *
 * @param pathname - Request pathname, no query
 */
export function errorCodePath(pathname: string): ErrorCodePath | undefined {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const match = CODE_PATH.exec(path);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  return { code: `OKM${raw.slice(3)}`, markdownFile: match?.[2] !== undefined };
}

/**
 * Extensionless path for one code.
 *
 * @param code - `OKM####`
 */
export function errorCodePageUrl(code: string): string {
  return `/docs/reference/errors/${code}`;
}

/**
 * Markdown twin for one code.
 *
 * @param code - `OKM####`
 */
export function errorCodeMarkdownUrl(code: string): string {
  return `/docs/reference/errors/${code}.md`;
}

/**
 * The registry code this request should rewrite to, or `undefined`.
 *
 * A `.md` URL always qualifies. The extensionless URL qualifies when Accept
 * prefers markdown. The code is the path segment of `/api/error-code/<CODE>`,
 * because a query string on a proxy rewrite does not reach the route.
 *
 * @param pathname - Request pathname
 * @param markdownPreferred - `Accept` prefers `text/markdown`
 */
export function errorCodeRewrite(pathname: string, markdownPreferred: boolean): string | undefined {
  const parsed = errorCodePath(pathname);
  if (parsed === undefined) return undefined;
  if (!parsed.markdownFile && !markdownPreferred) return undefined;
  return parsed.code;
}
