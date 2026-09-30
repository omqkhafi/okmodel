/**
 * Converts a Postgres LSN (`hi/lo`, hex) to a comparable integer.
 *
 * @param lsn - Value returned by `pg_current_wal_insert_lsn` or `pg_last_wal_replay_lsn`
 * @returns The byte position
 */
export function lsnToBigInt(lsn: string): bigint {
  const [hi, lo] = lsn.split("/");
  if (
    hi === undefined ||
    lo === undefined ||
    !/^[0-9A-Fa-f]+$/.test(hi) ||
    !/^[0-9A-Fa-f]+$/.test(lo)
  ) {
    throw new Error(`Invalid LSN '${lsn}'.`);
  }
  return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
}

/**
 * Compares two LSNs.
 *
 * @param left - First LSN
 * @param right - Second LSN
 * @returns Negative when `left` is behind, zero when equal, positive when ahead
 */
export function compareLsn(left: string, right: string): number {
  const a = lsnToBigInt(left);
  const b = lsnToBigInt(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
