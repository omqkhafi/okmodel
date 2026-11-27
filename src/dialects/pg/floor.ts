/**
 * Postgres floor a schema may name, and the features that read it.
 *
 * 15 is the oldest major. Any later integer is accepted. A value below 15,
 * or one that is not an integer, is refused when `schema()` runs.
 */

/** An integer major of {@link POSTGRES_FLOOR} or later. */
export type PostgresMajor = number;

/**
 * Oldest major connect accepts when the schema names no floor.
 *
 * A server below this is OKM1803.
 */
export const POSTGRES_FLOOR = 15;

/**
 * `uuidv7()` database default.
 *
 * Add the next feature constant beside this one, and name it on the minPostgres page.
 */
export const UUIDV7_POSTGRES = 18;

/** `NOT ENFORCED` checks. Creating one needs PostgreSQL 18. Altering one needs 19. */
export const NOT_ENFORCED_POSTGRES = 18 satisfies PostgresMajor;

/** `VIRTUAL` generated columns. PostgreSQL 18. */
export const VIRTUAL_POSTGRES = 18 satisfies PostgresMajor;

/** `WITHOUT OVERLAPS` and `PERIOD`. PostgreSQL 18. */
export const TEMPORAL_POSTGRES = 18 satisfies PostgresMajor;

/**
 * The sentence a temporal primary key or foreign key uses when the server is older.
 *
 * @returns The fix text
 */
export function temporalNeedsPostgres(): string {
  return `WITHOUT OVERLAPS and PERIOD need PostgreSQL ${String(TEMPORAL_POSTGRES)}. Use an exclusion constraint on an older server.`;
}

/**
 * Accepts an integer major of {@link POSTGRES_FLOOR} or later.
 *
 * @param value - Candidate from schema input
 * @returns Whether `value` is an integer the floor allows
 */
export function isPostgresMajor(value: unknown): value is PostgresMajor {
  return typeof value === "number" && Number.isInteger(value) && value >= POSTGRES_FLOOR;
}

/** `>=` and digits, the stored floor. */
const FLOOR_TEXT = /^>=(\d+)$/;

/**
 * Reads a stored `>=N` floor.
 *
 * `readFloor`, `refuseUuidV7`, and `acceptServer` share this parse.
 *
 * @param postgres - Stored or input range
 * @returns The major, or `NaN` when the text is not `>=` plus digits
 */
export function parsePostgresFloor(postgres: string | undefined): number {
  return Number(FLOOR_TEXT.exec(postgres ?? "")?.[1]);
}

/**
 * Stores a major as `>=N`.
 *
 * @param major - Allowed major
 * @returns The stored floor text
 */
export function formatPostgresFloor(major: number): string {
  return `>=${major}`;
}

/**
 * Definition error for a floor below {@link POSTGRES_FLOOR}, or not an integer.
 *
 * @returns OKM1060 message
 */
export function minPostgresDefinition(): string {
  return `minPostgres: ${String(POSTGRES_FLOOR)} or later.`;
}

/**
 * Sentence for a `uuidv7()` default the declared floor does not allow.
 *
 * @returns The OKM1812 message
 */
export function uuidv7NeedsPostgres(): string {
  const need = UUIDV7_POSTGRES;
  return `uuidv7() needs PostgreSQL ${need} or higher. minPostgres: ${need}.`;
}

/** OKM1812 sentence when `enforced: false` is declared below PostgreSQL 18. */
export function notEnforcedNeedsPostgres(): string {
  const need = NOT_ENFORCED_POSTGRES;
  return `A check with enforced: false needs PostgreSQL ${need} or higher. minPostgres: ${need}.`;
}

/**
 * Connect refusal when the server is below the schema floor.
 *
 * OKM1802 and OKM1803 share this sentence. OKM1803 passes {@link POSTGRES_FLOOR}.
 * Loaded with the connect check, not with `schema()`.
 *
 * @param server - Major the server reported
 * @param need - Major the schema requires
 * @returns The message
 */
export function serverNeedsPostgres(server: number, need: number): string {
  return `The server is PostgreSQL ${server}. This schema needs PostgreSQL ${need} or higher (minPostgres: ${need}).`;
}
