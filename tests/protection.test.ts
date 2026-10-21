/**
 * Protected-target store, command policy, and the headless refusal.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { exitCodeFor } from "../src/tooling/cli/outcome.js";
import { schemaFor, schemaProblems } from "../src/tooling/cli/schema.js";
import { COMMANDS, type CommandPolicy } from "../src/tooling/cli/spec.js";
import { hostDbFingerprint } from "../src/tooling/migrate/fingerprint.js";
import {
  addProtectedTarget,
  listProtectedTargets,
  removeProtectedTarget,
} from "../src/tooling/migrate/protect.js";
import {
  assertStoreTerminal,
  assertTargetPolicy,
  guardStoredDriverUrl,
  isStateChangingOperation,
  protectionReason,
  selectTarget,
} from "../src/tooling/migrate/policy.js";
import {
  readProtectedStore,
  storePathFor,
  writeProtectedStore,
} from "../src/tooling/migrate/protected-store.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");
const URL = "postgres://okm:secret@DB.Example:5432/App";

const STATE_CHANGING = [
  "migrate apply",
  "migrate resolve",
  "migrate baseline",
  "push",
  "seed",
  "driver test",
  "protect add",
  "protect remove",
] as const;

const FORBIDDEN = ["reset", "wipe", "destroy", "truncate", "nuke", "purge", "clean-db"] as const;

test("every command declares a policy, and a state-changing command has one", () => {
  const ids = new Set<string>();
  for (const command of COMMANDS) {
    expect(command.policy.length).toBeGreaterThan(0);
    ids.add(command.id);
    expect(command.policy).not.toBe("drop");
    expect(command.policy).not.toBe("rollback");
  }
  for (const id of STATE_CHANGING) {
    const command = COMMANDS.find((item) => item.id === id);
    expect(command, id).toBeDefined();
    expect(command?.policy).not.toBe("none");
    if (command !== undefined && command.policy !== "store" && command.policy !== "none") {
      expect(isStateChangingOperation(command.policy)).toBe(true);
    }
  }
  const stateChanging = new Set<string>(STATE_CHANGING);
  for (const command of COMMANDS) {
    if (!writes(command.policy)) continue;
    expect(stateChanging.has(command.id)).toBe(true);
  }
  expect(ids.has("protect list")).toBe(true);
  const list = COMMANDS.find((command) => command.id === "protect list");
  expect(list?.policy).toBe("none");
});

test("a refused guard exits 4 for every state-changing command", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-protect-add-"));
  const store = join(cwd, "protected.json");
  try {
    writeProject(cwd, URL, false);
    writeFileSync(store, "{");
    for (const id of STATE_CHANGING) {
      const command = COMMANDS.find((item) => item.id === id);
      expect(command, id).toBeDefined();
      if (command === undefined) continue;
      if (command.id === "protect add") {
        await expectCode(addProtectedTarget(cwd, undefined, store), "OKM1859");
        continue;
      }
      if (command.id === "protect remove") {
        await expectCode(removeProtectedTarget(cwd, undefined, store, false), "OKM1859");
        continue;
      }
      if (command.policy === "none" || command.policy === "store") continue;
      let caught: unknown;
      try {
        assertTargetPolicy(
          { name: "production", protected: true, protection: "store" },
          command.policy,
          true,
          { tty: false },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught, id).toBeInstanceOf(OkmError);
      if (caught instanceof OkmError) {
        expect(caught.code).toBe("OKM1859");
        expect(exitCodeFor(caught)).toBe(4);
        expect(caught.message).toContain("store fingerprint");
        expect(caught.fix.summary).toContain("friction, not proof of a human");
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("project config still honors --allow-protected, and the store does not", () => {
  expect(() =>
    assertTargetPolicy({ name: "production", protected: true }, "contract", true, { tty: false }),
  ).not.toThrow();
  expect(() =>
    assertTargetPolicy(
      { name: "production", protected: true, protection: "project" },
      "push",
      true,
      { tty: false },
    ),
  ).not.toThrow();
  let blocked: unknown;
  try {
    assertTargetPolicy(
      { name: "production", protected: true, protection: "project" },
      "push",
      false,
      { tty: false },
    );
  } catch (error) {
    blocked = error;
  }
  expect(blocked).toBeInstanceOf(OkmError);
  if (blocked instanceof OkmError) {
    expect(blocked.code).toBe("OKM1850");
    expect(blocked.message).toContain("project config");
    expect(blocked.message).toContain("blocked on protected target");
  }
  expect(() =>
    assertTargetPolicy({ name: "production", protected: true, protection: "store" }, "push", true, {
      tty: true,
    }),
  ).not.toThrow();
  let both: unknown;
  try {
    assertTargetPolicy(
      { name: "production", protected: true, protection: "project-and-store" },
      "seed",
      false,
      { tty: true },
    );
  } catch (error) {
    both = error;
  }
  if (both instanceof OkmError) {
    expect(both.message).toContain("project config and store fingerprint");
  }
  expect(() => assertTargetPolicy({ name: "production", protected: true }, "drop", true)).toThrow(
    "There is no down migration.",
  );
  expect(() =>
    assertStoreTerminal({ name: "production", protected: true }, "contract", false),
  ).not.toThrow();
});

test("the store is a union with project config and remove needs a terminal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-protect-union-"));
  const store = join(cwd, "okm", "protected.json");
  try {
    writeProject(cwd, URL, false);
    const added = await addProtectedTarget(cwd, undefined, store);
    expect(added.identity).toBeNull();
    expect(added.reason).toBe("store fingerprint");
    expect(added.hostDb).toBe(hostDbFingerprint("db.example", "5432", "App"));
    expect(JSON.stringify(added)).not.toContain("secret");
    expect(JSON.stringify(added)).not.toContain("DB.Example");
    expect(JSON.stringify(added)).not.toContain("postgres");
    const stored = selectTarget(configFor(false), undefined, { storePath: store });
    expect(stored.protected).toBe(true);
    expect(stored.protection).toBe("store");
    expect(protectionReason(stored)).toBe("store fingerprint");
    const both = selectTarget(configFor(true), undefined, { storePath: store });
    expect(both.protection).toBe("project-and-store");
    const still = selectTarget(configFor(false), undefined, { storePath: store });
    expect(still.protected).toBe(true);
    expect(still.protection).toBe("store");
    await expectCode(removeProtectedTarget(cwd, undefined, store, false), "OKM1859");
    expect(readProtectedStore(store).fingerprints).toContain(added.hostDb);
    const removed = await removeProtectedTarget(cwd, undefined, store, true);
    expect(removed.removed).toBe(true);
    expect(removed.identity).toBeNull();
    const open = selectTarget(configFor(false), undefined, { storePath: store });
    expect(open.protected).toBe(false);
    expect(open.protection).toBe("open");
    const again = await removeProtectedTarget(cwd, undefined, store, true);
    expect(again.removed).toBe(false);
    const listed = listProtectedTargets(store);
    expect(listed.fingerprints).toEqual([]);
    expect(schemaProblems(schemaFor("protect add"), added)).toEqual([]);
    expect(schemaProblems(schemaFor("protect remove"), removed)).toEqual([]);
    expect(schemaProblems(schemaFor("protect list"), listed)).toEqual([]);
    writeFileSync(store, "[]");
    expect(() => listProtectedTargets(store)).toThrow(OkmError);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("driver test refuses a stored url without a terminal", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-protect-driver-"));
  const store = join(cwd, "protected.json");
  try {
    const hostDb = hostDbFingerprint("db.example", "5432", "App");
    writeProtectedStore(store, [hostDb]);
    expect(() => guardStoredDriverUrl(URL, { storePath: store, tty: true })).not.toThrow();
    let caught: unknown;
    try {
      guardStoredDriverUrl(URL, { storePath: store, tty: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OkmError);
    if (caught instanceof OkmError) {
      expect(caught.code).toBe("OKM1859");
      expect(exitCodeFor(caught)).toBe(4);
    }
    expect(() =>
      guardStoredDriverUrl("postgres://okm:secret@other.example:5432/App", {
        storePath: store,
        tty: false,
      }),
    ).not.toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the store path follows XDG and APPDATA", () => {
  expect(storePathFor({ platform: "linux", home: "/home/dev", xdgConfigHome: undefined })).toBe(
    join("/home/dev", ".config", "okm", "protected.json"),
  );
  expect(storePathFor({ platform: "linux", home: "/home/dev", xdgConfigHome: "/xdg" })).toBe(
    join("/xdg", "okm", "protected.json"),
  );
  expect(
    storePathFor({
      platform: "win32",
      home: "C:\\Users\\dev",
      appData: "C:\\Users\\dev\\AppData\\Roaming",
    }),
  ).toBe(join("C:\\Users\\dev\\AppData\\Roaming", "okm", "protected.json"));
  const missing = join(mkdtempSync(join(tmpdir(), "okm-protect-missing-")), "nope.json");
  expect(readProtectedStore(missing)).toEqual({ version: 1, fingerprints: [] });
});

test("command names, exports, and bins have no reset command", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    readonly bin: Readonly<Record<string, string>>;
    readonly exports: Readonly<Record<string, unknown>>;
  };
  const words: string[] = [];
  for (const command of COMMANDS) {
    words.push(command.id, command.usage, command.summary, ...command.words);
  }
  words.push(...Object.keys(packageJson.bin), ...Object.keys(packageJson.exports));
  const text = words.join("\n");
  for (const token of FORBIDDEN) {
    expect(new RegExp(`\\b${token}\\b`).test(text), token).toBe(false);
  }
});

test("protect remove without a terminal exits 4", () => {
  const result = spawnSync("bun", [cli, "protect", "remove", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status).toBe(4);
  const body = JSON.parse(result.stdout) as {
    readonly exit: number;
    readonly errors: readonly { readonly code: string; readonly summary: string }[];
  };
  expect(body.exit).toBe(4);
  expect(body.errors[0]?.code).toBe("OKM1859");
  expect(body.errors[0]?.summary).not.toContain("postgres://");
});

test("a project-protected push names project config and exits 4", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-protect-push-"));
  try {
    writeProject(cwd, "postgres://127.0.0.1:1/db", true);
    const result = spawnSync("bun", [cli, "push", "--json"], { cwd, encoding: "utf8" });
    expect(result.status).toBe(4);
    const body = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string; readonly summary: string }[];
    };
    expect(body.errors[0]?.code).toBe("OKM1850");
    expect(body.errors[0]?.summary).toContain("project config");
    expect(body.errors[0]?.summary).not.toContain("127.0.0.1");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function writes(policy: CommandPolicy): boolean {
  if (policy === "store") return true;
  if (policy === "none") return false;
  return isStateChangingOperation(policy);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OkmError);
  if (caught instanceof OkmError) {
    expect(caught.code).toBe(code);
    expect(exitCodeFor(caught)).toBe(4);
  }
}

function configFor(protectedTarget: boolean) {
  return {
    schema: "./schema.ts",
    database: { url: URL, protected: protectedTarget },
  };
}

function writeProject(cwd: string, url: string, protectedTarget: boolean): void {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: { url: ${JSON.stringify(url)}, protected: ${protectedTarget} },`,
      "});",
      "",
    ].join("\n"),
  );
}
