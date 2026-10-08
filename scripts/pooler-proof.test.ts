/**
 * pooler-proof — R3 config rendering.
 */

import { describe, expect, test } from "bun:test";

import { POOLER_PORT, poolerConfig } from "./pooler-proof.js";

describe("R3 poolerConfig", () => {
  test("fronts the primary in transaction mode with rotation", () => {
    const ini = poolerConfig("127.0.0.1", "55432", "/tmp/proof");
    expect(ini).toContain("okm = host=127.0.0.1 port=55432 dbname=okm");
    expect(ini).toContain("pool_mode = transaction");
    expect(ini).toContain("server_round_robin = 1");
  });

  test("the listen port dodges the static pooler check", () => {
    expect(String(POOLER_PORT)).not.toBe("6432");
    expect(String(POOLER_PORT)).not.toBe("6543");
    expect(poolerConfig("127.0.0.1", "55432", "/tmp/proof")).toContain(
      `listen_port = ${String(POOLER_PORT)}`,
    );
  });
});
