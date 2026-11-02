import { createHash } from "node:crypto";

/** sha256 of an API key, as hex. Only this is stored. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
