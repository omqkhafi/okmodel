/**
 * One in-flight catalog load per key.
 *
 * Concurrent `connect()` calls in one process share the parse. A failure is
 * dropped so the next call can try again. Success stays for the process.
 */

const inflight = new Map<string, Promise<void>>();

/**
 * Runs `load` once for `key`.
 *
 * The map is filled before `load` starts, so a second call on the same tick
 * waits on the first promise instead of parsing again.
 *
 * @param key - Directory and hash, or the artifact hash
 * @param load - Reads and trusts the catalog
 * @returns The shared load
 */
export function loadOnce(key: string, load: () => Promise<void>): Promise<void> {
  const found = inflight.get(key);
  if (found !== undefined) return found;
  const pending = Promise.resolve().then(load);
  inflight.set(key, pending);
  void pending.catch(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  return pending;
}
