/**
 * `bun add` and `bunx` fences become the four package-manager commands.
 */

import { expect, test } from "bun:test";

import { INSTALL_DRIVERS, PACKAGE_MANAGERS, installCommand, installDriverChoice, installDriverForFence, translatePackageScript } from "./package-managers";

test("bun add becomes install commands for each manager", () => {
  expect(translatePackageScript("bun add okmodel postgres")).toEqual({
    bun: "bun add okmodel postgres",
    npm: "npm install okmodel postgres",
    yarn: "yarn add okmodel postgres",
    pnpm: "pnpm add okmodel postgres",
  });
});

test("bunx lines become the local runner for each manager", () => {
  expect(translatePackageScript("bunx okm build\nbunx okm generate init\n")).toEqual({
    bun: "bunx okm build\nbunx okm generate init",
    npm: "npx okm build\nnpx okm generate init",
    yarn: "yarn okm build\nyarn okm generate init",
    pnpm: "pnpm exec okm build\npnpm exec okm generate init",
  });
});

test("bun is the first package-manager tab, and every driver has a note", () => {
  expect(PACKAGE_MANAGERS[0]).toBe("bun");
  expect(INSTALL_DRIVERS.map((driver) => driver.id)).toEqual(["postgresjs", "pg", "pglite", "bun"]);
  for (const driver of INSTALL_DRIVERS) expect(driver.note.length, driver.id).toBeGreaterThan(0);
});

test("an okmodel install names the driver package", () => {
  expect(installDriverChoice("bun add okmodel postgres")).toBe("postgresjs");
  expect(installDriverChoice("bun add okmodel pg")).toBe("pg");
  expect(installDriverChoice("bun add okmodel @electric-sql/pglite")).toBe("pglite");
  expect(installDriverChoice("bun add okmodel")).toBe("bun");
  expect(installDriverChoice("bunx okm build")).toBeNull();
  expect(installCommand("pglite", "npm")).toBe("npm install okmodel @electric-sql/pglite");
  expect(installCommand("bun", "yarn")).toBe("yarn add okmodel");
  expect(installCommand("pg", "bun")).toBe("bun add okmodel pg\nbun add -D @types/pg");
  expect(installCommand("pg", "npm")).toBe("npm install okmodel pg\nnpm install -D @types/pg");
  expect(installCommand("pg", "yarn")).toBe("yarn add okmodel pg\nyarn add -D @types/pg");
  expect(installCommand("pg", "pnpm")).toBe("pnpm add okmodel pg\npnpm add -D @types/pg");
});

test("a titled install fence does not switch drivers", () => {
  expect(installDriverForFence("bun add okmodel postgres", "postgres.js")).toBeNull();
  expect(installDriverForFence("bun add okmodel postgres")).toBe("postgresjs");
});

test("a shell command that is not an install stays a normal block", () => {
  expect(translatePackageScript("okm migrate apply --target production")).toBeNull();
  expect(translatePackageScript("bun run build")).toBeNull();
  expect(translatePackageScript("")).toBeNull();
});
