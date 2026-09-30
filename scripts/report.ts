/**
 * Prints each problem and exits when the list is not empty.
 */
export function exitOnProblems(problems: readonly string[]): void {
  if (problems.length === 0) {
    return;
  }
  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(1);
}
