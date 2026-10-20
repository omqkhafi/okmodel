/**
 * Notices a command would write to stderr.
 *
 * `--json` collects them into `warnings` so stderr stays empty. A human run
 * still writes the line.
 */

/** One notice. */
export type CliNotice = {
  readonly summary: string;
};

let current: CliNotice[] | undefined;

/**
 * Collects {@link cliNotice} calls made while `run` is in progress.
 *
 * @param run - Command body
 * @returns The result and the notices
 */
export async function collectNotices<T>(run: () => Promise<T>): Promise<{
  readonly result: T;
  readonly notices: readonly CliNotice[];
}> {
  const previous = current;
  const notices: CliNotice[] = [];
  current = notices;
  try {
    const result = await run();
    return { result, notices };
  } finally {
    current = previous;
  }
}

/**
 * Records a notice, or writes it to stderr when no collector is active.
 *
 * @param summary - One line, without a trailing newline
 */
export function cliNotice(summary: string): void {
  if (current !== undefined) {
    current.push({ summary });
    return;
  }
  process.stderr.write(`${summary}\n`);
}
