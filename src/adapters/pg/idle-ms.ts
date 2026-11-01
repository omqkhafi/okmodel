/**
 * Default and resolution for pool `idleTimeoutMs`.
 *
 * One place so every driver that supports idle close shares the same default.
 */

/** Default pool idle timeout in milliseconds. */
export const DEFAULT_IDLE_MS = 30_000;

/**
 * Resolves `idleTimeoutMs` for a pool open.
 *
 * @param value - Connect/open option. Omitted means {@link DEFAULT_IDLE_MS}
 * @returns Milliseconds passed to the driver. `0` disables idle close
 */
export function idleMs(value: number | undefined): number {
  return value ?? DEFAULT_IDLE_MS;
}
