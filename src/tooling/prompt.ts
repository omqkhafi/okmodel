/**
 * One line of input from the terminal.
 *
 * The question goes to stderr so `--json` output on stdout stays clean.
 * Callers ask only when stdin is a terminal and neither `--yes` nor
 * `--json` was passed.
 */

/**
 * Asks one question and returns the trimmed answer.
 *
 * @param label - The prompt text
 * @returns The answer, possibly empty
 */
export async function ask(label: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const prompts = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await prompts.question(label)).trim();
  } finally {
    prompts.close();
  }
}
