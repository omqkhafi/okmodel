/**
 * Package-manager lines for the terminal snippet.
 * A fence is a snippet only when every line is `bun add` or `bunx`.
 * Other shell stays a normal code block.
 */

/** Managers shown in the terminal, in tab order. Bun is the handbook default. */
export const PACKAGE_MANAGERS = ["bun", "npm", "yarn", "pnpm"] as const;

/** One package manager tab. */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Translated command text, one string per manager. */
export type PackageCommands = Record<PackageManager, string>;

/**
 * Drivers the install terminal can switch. Package names and `note` follow
 * the README install paragraph: which runtime, and whether a server is required.
 */
export const INSTALL_DRIVERS = [
  {
    id: "postgresjs",
    label: "postgres.js",
    packageName: "postgres",
    note: "Default on Node and Bun. Connects to a Postgres server.",
  },
  {
    id: "pg",
    label: "node-postgres",
    packageName: "pg",
    note: "On Node or Bun, when pg is already installed. pg ships no types, so @types/pg is a dev dependency.",
  },
  {
    id: "pglite",
    label: "PGlite",
    packageName: "@electric-sql/pglite",
    note: "On Node or Bun. Postgres runs in the process, so there is no server to start.",
  },
  {
    id: "bun",
    label: "Bun.sql",
    packageName: null,
    note: "On Bun. No extra package, and it does not run on Node.",
  },
] as const;

/** One install-driver tab. */
export type InstallDriverId = (typeof INSTALL_DRIVERS)[number]["id"];

/**
 * Whether a stored value is an install-driver tab.
 *
 * @param value - Untrusted string
 */
export function isInstallDriver(value: string | null): value is InstallDriverId {
  return INSTALL_DRIVERS.some((driver) => driver.id === value);
}

/**
 * Whether a stored value is a package manager tab.
 *
 * @param value - Untrusted string
 */
export function isPackageManager(value: string | null): value is PackageManager {
  return value === "npm" || value === "yarn" || value === "pnpm" || value === "bun";
}

/**
 * Translate a Bun install or `bunx` script into the other managers.
 * Returns null when any line is not one of those two commands.
 *
 * @param source - Fence body, one command per line
 */
export function translatePackageScript(source: string): PackageCommands | null {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const commands: Record<PackageManager, string[]> = {
    npm: [],
    yarn: [],
    pnpm: [],
    bun: [],
  };

  for (const line of lines) {
    const translated = translateLine(line);
    if (translated === null) return null;
    for (const manager of PACKAGE_MANAGERS) {
      commands[manager].push(translated[manager]);
    }
  }

  return {
    npm: commands.npm.join("\n"),
    yarn: commands.yarn.join("\n"),
    pnpm: commands.pnpm.join("\n"),
    bun: commands.bun.join("\n"),
  };
}

/**
 * The driver named by a single `bun add okmodel` line, or null when the fence
 * is not that install.
 *
 * @param source - Fence body
 */
export function installDriverChoice(source: string): InstallDriverId | null {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  const match = /^bun add okmodel(?:\s+(\S+))?$/.exec(lines[0] ?? "");
  if (!match) return null;
  const packageName = match[1];
  if (packageName === undefined) return "bun";
  const driver = INSTALL_DRIVERS.find((item) => item.packageName === packageName);
  return driver?.id ?? null;
}

/**
 * Install command for one driver and one package manager.
 *
 * @param driver - Driver tab
 * @param manager - Package manager tab
 */
export function installCommand(driver: InstallDriverId, manager: PackageManager): string {
  const spec = INSTALL_DRIVERS.find((item) => item.id === driver);
  const packageName = spec?.packageName;
  const packages = packageName === undefined || packageName === null ? "okmodel" : `okmodel ${packageName}`;
  const lines = [`bun add ${packages}`];
  if (driver === "pg") lines.push("bun add -D @types/pg");
  return lines
    .map((line) => {
      const translated = translateLine(line);
      return translated === null ? line : translated[manager];
    })
    .join("\n");
}

/**
 * One `bun add` or `bunx` line.
 *
 * @param line - Trimmed command
 */
function translateLine(line: string): PackageCommands | null {
  const add = /^bun add(?:\s+(.*))?$/.exec(line);
  if (add) {
    const args = add[1] ?? "";
    const rest = args.length > 0 ? ` ${args}` : "";
    return {
      bun: `bun add${rest}`,
      npm: `npm install${rest}`,
      yarn: `yarn add${rest}`,
      pnpm: `pnpm add${rest}`,
    };
  }

  const exec = /^bunx(?:\s+(.*))?$/.exec(line);
  if (exec) {
    const args = exec[1] ?? "";
    const rest = args.length > 0 ? ` ${args}` : "";
    return {
      bun: `bunx${rest}`,
      npm: `npx${rest}`,
      yarn: `yarn${rest}`,
      pnpm: `pnpm exec${rest}`,
    };
  }

  return null;
}
