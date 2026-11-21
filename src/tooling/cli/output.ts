/**
 * The one place `okm` prints, colors, and wraps (D330).
 *
 * Every command writes through {@link writeOut} and {@link writeErr}. The mode
 * comes from the environment and the stream, never from a flag. `--json`
 * does not use this module: it writes one envelope and nothing else.
 *
 * - Pretty: stdout is a terminal, `NO_COLOR` is unset, `TERM` is not `dumb`,
 *   and `CI` is unset. `FORCE_COLOR` forces it.
 * - Plain: everything else. No ANSI, and the same words as pretty.
 *
 * Color marks the severity word and the code. One dim marks secondary lines.
 * Prose wraps on a terminal only, at its width or {@link DEFAULT_COLUMNS}. A
 * pipe keeps each message on one line so a log stays greppable. Nothing here reads stdin, switches the terminal to raw mode, or draws.
 */

/** How one invocation prints. */
export type OutputMode = {
  /** `true` when severity words, codes, and secondary lines get ANSI. */
  readonly pretty: boolean;
  /** Where prose wraps. `Infinity` on a pipe, which is never wrapped. */
  readonly columns: number;
};

/** The environment names this module reads. */
export type OutputEnv = Readonly<Record<string, string | undefined>>;

/** What a stream says about itself. */
export type OutputStream = { readonly isTTY?: boolean; readonly columns?: number };

/** Width used when a terminal does not report one. */
export const DEFAULT_COLUMNS = 80;

const ESC = "\u001b[";

/**
 * Picks pretty or plain for one stream.
 *
 * `FORCE_COLOR` (anything but empty, `0`, or `false`) forces pretty and wins
 * over `NO_COLOR`. `FORCE_COLOR=0` forces plain.
 *
 * @param stream - Normally `process.stdout`
 * @param env - Normally `process.env`
 * @returns The mode
 */
export function outputMode(
  stream: OutputStream = process.stdout,
  env: OutputEnv = process.env,
): OutputMode {
  const width =
    typeof stream.columns === "number" && stream.columns > 0 ? stream.columns : DEFAULT_COLUMNS;
  const columns = stream.isTTY === true ? width : Number.POSITIVE_INFINITY;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") {
    return { pretty: force !== "0" && force !== "false", columns };
  }
  const set = (name: string): boolean => env[name] !== undefined && env[name] !== "";
  const pretty = stream.isTTY === true && !set("NO_COLOR") && env.TERM !== "dumb" && !set("CI");
  return { pretty, columns };
}

/** The mode with no ANSI and no wrapping. Direct callers and tests default to it. */
export const PLAIN: OutputMode = { pretty: false, columns: Number.POSITIVE_INFINITY };

const SEVERITY_COLOR: Readonly<Record<string, string>> = {
  error: "31",
  warning: "33",
  ok: "32",
};

function paint(mode: OutputMode, color: string, text: string): string {
  return mode.pretty ? `${ESC}${color}m${text}${ESC}0m` : text;
}

/**
 * Dims a secondary line.
 *
 * @param mode - Output mode
 * @param text - One line without a newline
 * @returns The text, wrapped in ANSI only in pretty mode
 */
export function dim(mode: OutputMode, text: string): string {
  return paint(mode, "2", text);
}

/**
 * Colors a severity word and its code.
 *
 * @param mode - Output mode
 * @param level - `error`, `warning`, or `ok`
 * @param code - Code that follows the word, when there is one
 * @returns `error OKM1520`, with both words colored in pretty mode
 */
export function severity(mode: OutputMode, level: string, code?: string): string {
  const color = SEVERITY_COLOR[level] ?? "31";
  const word = paint(mode, color, level);
  return code === undefined ? word : `${word} ${paint(mode, color, code)}`;
}

/**
 * Wraps one paragraph of prose at `columns`.
 *
 * A word is never split, so a path or a code longer than the width stays on
 * one line. Continuation lines start with `indent`.
 *
 * @param text - One paragraph, no newlines
 * @param columns - Width, from {@link OutputMode}
 * @param indent - Prefix of every line after the first
 * @returns The paragraph with newlines
 */
export function wrap(text: string, columns: number, indent = ""): string {
  if (!Number.isFinite(columns) || text.length <= columns) return text;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= columns) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = `${indent}${word}`;
    }
  }
  lines.push(line);
  return lines.join("\n");
}

const PREFIXED = /^(error|warning) (OKM\d{4}|[a-z_]+)(?=[: ])/;
const OK_LINE = /^ok(?=\s|$)/;
const SECONDARY = /^(config|note|Details):? /;

/**
 * Applies pretty styling to text a command wrote.
 *
 * Plain mode returns the text untouched. Pretty mode colors the severity word
 * and code at the start of a line, the leading `ok`, and dims `config:`,
 * `note:`, and `Details:` lines. No other line changes.
 *
 * @param text - Output with newlines
 * @param mode - Output mode
 * @returns The styled text
 */
export function styleText(text: string, mode: OutputMode): string {
  if (!mode.pretty || text.length === 0) return text;
  return text
    .split("\n")
    .map((line) => {
      if (SECONDARY.test(line)) return dim(mode, line);
      const found = PREFIXED.exec(line);
      if (found !== null) {
        const head = severity(mode, found[1] ?? "error", found[2]);
        return `${head}${line.slice(found[0].length)}`;
      }
      const ok = OK_LINE.exec(line);
      return ok === null ? line : `${severity(mode, "ok")}${line.slice(2)}`;
    })
    .join("\n");
}

/**
 * Writes command output to stdout.
 *
 * @param text - Text with its own newlines
 */
export function writeOut(text: string): void {
  process.stdout.write(styleText(text, outputMode()));
}

/**
 * Writes a notice, a note, or a failure to stderr.
 *
 * The mode follows stdout, so a piped run is plain on both streams.
 *
 * @param text - Text with its own newlines
 */
export function writeErr(text: string): void {
  process.stderr.write(styleText(text, outputMode()));
}
