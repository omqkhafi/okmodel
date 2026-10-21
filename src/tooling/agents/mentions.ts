/**
 * Finds `okm` command mentions in text that ships to an agent.
 *
 * A mention is `okm` followed by command words. `.okm` paths and a bare
 * `okm` are not commands. The longest command in {@link COMMANDS} wins.
 */

import { COMMANDS, GLOBAL_FLAGS } from "../cli/spec.js";

/**
 * `okm` commands named in `text`, longest match first.
 *
 * A mention that matches no command is returned as `bad`.
 *
 * @param text - Block, skill, or doc source
 * @returns Resolved command ids and the unmatched `okm` phrases
 */
export function okmMentions(text: string): {
  readonly ids: readonly string[];
  readonly bad: readonly string[];
} {
  const ids: string[] = [];
  const bad: string[] = [];
  const ordered = [...COMMANDS].sort((left, right) => right.words.length - left.words.length);
  const marker = /\bokm\b/g;
  for (const match of text.matchAll(marker)) {
    const index = match.index;
    if (index === undefined) continue;
    const before = index === 0 ? "" : text[index - 1];
    if (before === "." || before === "/" || before === "_" || before === "-") continue;
    const rest = text.slice(index + match[0].length);
    if (!/^\s+[A-Za-z]/.test(rest)) continue;
    const command = ordered.find((item) => matchesWords(rest, item.words));
    if (command !== undefined) {
      ids.push(command.id);
      continue;
    }
    const phrase = /^\s*([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*){0,3})/.exec(rest);
    bad.push(phrase?.[1]?.trim() ?? "");
  }
  return { ids, bad };
}

/**
 * Long flags named in text that ships to an agent.
 *
 * A flag is `--` followed by a lowercase name. `-- okm-allow` is a
 * migration comment, not a flag. A flag counts as real when the global set
 * or any command in {@link COMMANDS} accepts it.
 *
 * @param text - Block, skill, or doc source
 * @returns The flags found, and those no command accepts
 */
export function flagMentions(text: string): {
  readonly flags: readonly string[];
  readonly bad: readonly string[];
} {
  const known = new Set<string>(GLOBAL_FLAGS.map((flag) => flag.name));
  for (const command of COMMANDS) for (const flag of command.flags) known.add(flag.name);
  const flags = [...text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((match) => match[1] ?? "");
  return { flags, bad: flags.filter((flag) => !known.has(flag)).map((flag) => `--${flag}`) };
}

function matchesWords(rest: string, words: readonly string[]): boolean {
  let offset = 0;
  for (const word of words) {
    const spaced = new RegExp(`\\s+${word}(?![A-Za-z-])`, "y");
    spaced.lastIndex = offset;
    const match = spaced.exec(rest);
    if (match === null) return false;
    offset = match.index + match[0].length;
  }
  return words.length > 0;
}
