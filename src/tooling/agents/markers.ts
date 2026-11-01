/**
 * The managed block inside a text file.
 *
 * A block is one `<!-- BEGIN OKMODEL v<version> -->` line, the lines between,
 * and one `<!-- END OKMODEL -->` line. Every byte outside it is left alone. A
 * file with a damaged or repeated marker is refused, not repaired.
 */

import { refuseMarkers } from "./guards.js";

/** The last line of a block. */
const BLOCK_END = "<!-- END OKMODEL -->";

const BEGIN_LINE = /^<!-- BEGIN OKMODEL v([0-9A-Za-z][0-9A-Za-z.+-]*) -->$/;
const MARKER_LIKE = /^<!--\s*(BEGIN|END)\s+OKMODEL/i;

/** One block found in a file. Offsets index the original text. */
export type BlockRegion = {
  /** Offset of the first byte of the BEGIN line. */
  readonly start: number;
  /** Offset after the END line and its line terminator, when it has one. */
  readonly end: number;
  /** Version in the BEGIN marker. */
  readonly version: string;
  /** The bytes from `start` to `end`. */
  readonly text: string;
};

type Marker = {
  readonly kind: "begin" | "end";
  readonly start: number;
  readonly next: number;
  readonly line: number;
  readonly version: string;
};

/**
 * Finds the one block in `text`.
 *
 * Only a whole line that starts with `<!-- BEGIN OKMODEL` or
 * `<!-- END OKMODEL` counts, so prose that quotes a marker is not a marker.
 *
 * @param text - File text
 * @param path - Project-relative path, for the refusal
 * @returns The block, or `undefined` when the file has no marker
 * @throws OkmError OKM1882 for a damaged marker, OKM1883 for a repeated block
 */
export function findBlock(text: string, path: string): BlockRegion | undefined {
  const markers = scan(text, path);
  if (markers.length === 0) return undefined;
  const first = markers[0];
  if (first === undefined) return undefined;
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const expected = index % 2 === 0 ? "begin" : "end";
    if (marker?.kind !== expected) refuseMarkers("damaged", path, (marker ?? first).line);
  }
  if (markers.length % 2 === 1) refuseMarkers("damaged", path, (markers.at(-1) ?? first).line);
  if (markers.length > 2) refuseMarkers("duplicated", path, (markers[2] ?? first).line);
  const end = markers[1];
  if (end === undefined) return undefined;
  return {
    start: first.start,
    end: end.next,
    version: first.version,
    text: text.slice(first.start, end.next),
  };
}

/**
 * Line terminator a file uses. A file with any CRLF is CRLF.
 *
 * @param text - File text
 * @returns `\r\n` or `\n`
 */
function eolOf(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Adds a block after the existing text.
 *
 * One blank line separates the block from what came before, and a file with
 * no final newline gets one. The original bytes stay a prefix of the result.
 *
 * @param text - Existing file text, possibly empty
 * @param block - Block with `\n` line endings, ending in a newline
 * @returns The new file text
 */
export function insertBlock(text: string, block: string): string {
  if (text.length === 0) return block;
  const eol = eolOf(text);
  const lead = (text.endsWith("\n") ? "" : eol) + eol;
  return `${text}${lead}${withEol(block, eol)}`;
}

/**
 * Swaps the block for a new one and keeps every other byte.
 *
 * @param text - File text
 * @param region - The block {@link findBlock} returned
 * @param block - New block with `\n` line endings, ending in a newline
 * @returns The new file text
 */
export function replaceBlock(text: string, region: BlockRegion, block: string): string {
  const eol = eolOf(region.text);
  let next = withEol(block, eol);
  if (!region.text.endsWith("\n")) next = next.slice(0, next.length - eol.length);
  return `${text.slice(0, region.start)}${next}${text.slice(region.end)}`;
}

/**
 * Deletes the block. A blank line that {@link insertBlock} added before a
 * block at the end of the file goes with it.
 *
 * @param text - File text
 * @param region - The block {@link findBlock} returned
 * @returns The new file text
 */
export function removeBlock(text: string, region: BlockRegion): string {
  const before = text.slice(0, region.start);
  const after = text.slice(region.end);
  if (after.length === 0 && /\r?\n\r?\n$/.test(before)) {
    return before.slice(0, before.length - (before.endsWith("\r\n") ? 2 : 1));
  }
  return `${before}${after}`;
}

/**
 * Whether a file has a line that imports `AGENTS.md` for Claude Code.
 *
 * @param text - `CLAUDE.md` text
 * @returns `true` when a whole line is `@AGENTS.md`
 */
export function hasImportLine(text: string): boolean {
  return /^@AGENTS\.md[ \t]*\r?$/m.test(text);
}

function withEol(text: string, eol: "\n" | "\r\n"): string {
  return eol === "\n" ? text : text.replaceAll("\n", eol);
}

function scan(text: string, path: string): readonly Marker[] {
  const markers: Marker[] = [];
  let offset = 0;
  let line = 1;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const next = newline === -1 ? text.length : newline + 1;
    const raw = text.slice(offset, newline === -1 ? text.length : newline);
    const content = raw.endsWith("\r") ? raw.slice(0, raw.length - 1) : raw;
    const like = MARKER_LIKE.exec(content);
    if (like !== null) {
      const begin = BEGIN_LINE.exec(content);
      if (begin !== null) {
        markers.push({ kind: "begin", start: offset, next, line, version: begin[1] ?? "" });
      } else if (content === BLOCK_END) {
        markers.push({ kind: "end", start: offset, next, line, version: "" });
      } else {
        refuseMarkers("damaged", path, line);
      }
    }
    offset = next;
    line += 1;
  }
  return markers;
}
