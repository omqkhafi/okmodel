/**
 * A trivial type measured by `tsc --extendedDiagnostics`.
 */
type Id<T> = T extends unknown ? T : never;

export type Trivial = Id<{ readonly value: number }>;
