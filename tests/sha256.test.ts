import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { sha256 } from "../src/contracts/sha256.js";

/** FIPS 180-4 and extra UTF-8 vectors. Digests are lowercase hex. */
const VECTORS: readonly { readonly text: string; readonly digest: string }[] = [
  {
    text: "",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    text: "abc",
    digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  {
    text: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    digest: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  },
  {
    text: "a".repeat(1_000_000),
    digest: "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  },
  {
    text: "€",
    digest: "c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d",
  },
];

test("sha256 matches the published test vectors", () => {
  for (const vector of VECTORS) {
    expect(sha256(vector.text)).toBe(vector.digest);
  }
});

test("the contracts hash does not call a host crypto API", () => {
  const source = readFileSync(join(repoRoot(), "src", "contracts", "sha256.ts"), "utf8");
  expect(source).not.toContain("node:");
  expect(source).not.toContain("Bun.");
  expect(source).not.toContain("CryptoHasher");
  expect(source).not.toContain("crypto.");
});
