/**
 * UUID client generators.
 *
 * `uuidv4` is `crypto.randomUUID()`. `uuidv7` is ours, so a server older than
 * Postgres 18 can still have time-ordered ids without a database function.
 */

import { clientGenerator, type ClientGenerator } from "../../contracts/generator.js";

const HEX = "0123456789abcdef";

/**
 * One random UUID, version 4.
 *
 * @returns Canonical 8-4-4-4-12 text
 */
export const uuidv4: ClientGenerator<string> = clientGenerator(() => crypto.randomUUID(), "uuidv4");

/**
 * One time-ordered UUID, version 7.
 *
 * The first 48 bits are the Unix epoch in milliseconds. The rest is random.
 *
 * @returns Canonical 8-4-4-4-12 text
 */
export const uuidv7: ClientGenerator<string> = clientGenerator(mintUuidV7, "uuidv7");

function mintUuidV7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const now = Date.now();
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  const sixth = bytes[6] ?? 0;
  const eighth = bytes[8] ?? 0;
  bytes[6] = (sixth & 0x0f) | 0x70;
  bytes[8] = (eighth & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out += "-";
    const byte = bytes[index] ?? 0;
    out += HEX[byte >> 4];
    out += HEX[byte & 0x0f];
  }
  return out;
}
