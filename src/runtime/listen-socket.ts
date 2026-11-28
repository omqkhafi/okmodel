/**
 * Channel quoting for a dedicated LISTEN connection.
 *
 * The opener registry lives in `client.ts`, which the connect entry already
 * loads. This file is imported by the driver openers only.
 */

/** Quotes a channel for `LISTEN`. A colon is legal inside the quotes. */
export function quoteChannel(channel: string): string {
  return `"${channel.replaceAll('"', '""')}"`;
}
