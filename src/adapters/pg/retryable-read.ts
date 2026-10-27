/**
 * Whether a failed statement can be sent again.
 *
 * Transaction control, writes, locks, and `WITH` are not retried: `WITH` can
 * hide a write. A plain read cannot repeat one.
 *
 * @param text - Statement text
 * @returns `true` when running the statement again cannot repeat a write
 */
export function retryableRead(text: string): boolean {
  const head = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (head.length === 0 || head.includes("pg_advisory")) return false;
  if (/\sfor (?:no key update|key share|update|share)\b/.test(head)) return false;
  return !/^(?:insert|update|delete|refresh|with|create|alter|drop|truncate|grant|revoke|comment|vacuum|analyze|reindex|copy|begin|start|commit|rollback|savepoint|release|set|reset)\b/.test(
    head,
  );
}
