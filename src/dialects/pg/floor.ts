/**
 * Postgres majors a schema may name, and the features that read them.
 *
 * 15–18 are the majors okmodel runs. A major outside that range is refused
 * when `schema()` runs. Messages read these numbers. They do not repeat them.
 */

/** Majors `minPostgres` and `requires.postgres` accept, oldest first. */
export const POSTGRES_MAJORS = [15, 16, 17, 18] as const;

/** A major {@link POSTGRES_MAJORS} allows. */
export type PostgresMajor = (typeof POSTGRES_MAJORS)[number];

/**
 * Oldest major connect accepts when the schema names no floor.
 *
 * A server below this is OKM1803.
 */
export const POSTGRES_FLOOR = 15 satisfies PostgresMajor;

/**
 * `uuidv7()` database default.
 *
 * Add the next feature constant beside this one, and name it on the minPostgres page.
 */
export const UUIDV7_POSTGRES = 18 satisfies PostgresMajor;

/**
 * Accepts a major from {@link POSTGRES_MAJORS}.
 *
 * @param value - Candidate from schema input
 * @returns Whether `value` is 15, 16, 17, or 18
 */
export function isPostgresMajor(value: unknown): value is PostgresMajor {
  // 15 is {@link POSTGRES_FLOOR}. 18 is the newest major okmodel runs.
  return typeof value === "number" && (value | 0) === value && value >= 15 && value <= 18;
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
 * Definition error for a floor outside 15–18.
 *
 * @returns OKM1060 message
 */
export function minPostgresDefinition(): string {
  return "minPostgres: 15-18.";
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
