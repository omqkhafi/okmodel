/**
 * SCRAM-SHA-256 verifier, computed on the client.
 *
 * The string is the form PostgreSQL stores in `rolpassword`. A server that
 * refuses a client verifier is reported by the caller. This module does not
 * retry with plaintext.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/** Iterations PostgreSQL uses for SCRAM-SHA-256. */
const ITERATIONS = 4096;

/**
 * Builds a SCRAM-SHA-256 verifier.
 *
 * Salt is 16 bytes. The stored key and the server key match
 * `password_encryption = scram-sha-256` on the server when the salt and the
 * iteration count are the same.
 *
 * @param password - The password. It is not returned
 * @param salt - Salt. A new one is used when omitted
 * @param iterations - PBKDF2 rounds. The default is 4096
 * @returns `SCRAM-SHA-256$<iter>:<salt>$<stored>:<server>`
 */
export function scramVerifier(
  password: string,
  salt = randomBytes(16),
  iterations = ITERATIONS,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * Rebuilds a verifier from a stored `rolpassword` and the same password.
 *
 * @param password - The password that was set
 * @param stored - `rolpassword`
 * @returns A verifier with that salt, or `undefined` when the stored value is not SCRAM
 */
export function scramFromStored(password: string, stored: string): string | undefined {
  const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(stored);
  const rounds = match?.[1];
  const salt = match?.[2];
  if (rounds === undefined || salt === undefined) return undefined;
  return scramVerifier(password, Buffer.from(salt, "base64"), Number(rounds));
}
