/**
 * Dispatch for `okm roles` and `okm access`.
 */

import { OkmError } from "../../contracts/error.js";
import type { ParsedCli } from "../cli/parse.js";
import type { ProjectContext } from "./paths.js";
import { loadConfig } from "./project.js";
import { selectTarget } from "./policy.js";
import { migrationUrl } from "./purpose-url.js";
import { accessReport } from "./access-cmd.js";
import {
  applyRoles,
  generateRoles,
  roleStatus,
  setRolePassword,
  type PasswordFlags,
} from "./roles-cmd.js";

/** What {@link rolesCli} returns. Human text is already written when JSON is off. */
type Produced = {
  readonly text: string;
  readonly data: unknown;
  readonly warnings: readonly [];
  readonly outFile: null;
};

/**
 * Runs one roles or access command.
 *
 * @param id - Command id
 * @param project - Project context
 * @param parsed - Parsed flags
 * @param human - Human writer
 * @param terminal - Whether the process has a terminal
 * @returns The envelope payload. Secrets stay out of `data`
 */
export async function rolesCli(
  id: string,
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
  terminal: boolean,
): Promise<Produced> {
  const config = await loadConfig(project);
  const flags: PasswordFlags = {
    plain: parsed.plain,
    acceptWeakPassword: parsed.acceptWeakPassword,
    generate: parsed.generate,
    ...(parsed.envFile !== undefined ? { envFile: parsed.envFile } : {}),
    json: parsed.json,
  };
  if (id === "roles generate") {
    const text = generateRoles(config, flags, terminal, project.cwd);
    human(text);
    return { text, data: { text: "generated" }, warnings: [], outFile: null };
  }
  if (id === "roles apply" || id === "roles set-password") {
    const admin = parsed.adminEnv;
    if (admin === undefined) {
      throw new OkmError("OKM1912", `${id} needs --admin-env NAME.`, {
        fix: { summary: "Pass --admin-env NAME. The URL is not an argument." },
      });
    }
    const text =
      id === "roles apply"
        ? await applyRoles(config, admin, flags, terminal)
        : await setRolePassword(config, parsed.operands[0] ?? "", admin, flags, terminal);
    human(text);
    return { text, data: { text: text.trim() }, warnings: [], outFile: null };
  }
  const target = selectTarget(config, parsed.target);
  const url = migrationUrl(config, target);
  if (id === "access") {
    const report = await accessReport(config, url, parsed.operands[0] ?? "");
    const text = `${report.grants.map((grant) => `${grant.object} ${grant.privilege} ${grant.role} grantor ${grant.grantor}`).join("\n")}\n${report.eventTriggers}\n`;
    human(text);
    return { text, data: report, warnings: [], outFile: null };
  }
  const status = await roleStatus(config, url);
  const text = status.rows
    .map((row) => {
      const extra =
        row.strict !== undefined && row.strict.length > 0 ? ` strict ${row.strict.join(",")}` : "";
      return `${row.scope} ${row.name} exists ${String(row.exists)} login ${row.login}${extra}`;
    })
    .join("\n");
  human(`${text}\n`);
  if (status.failed) {
    throw new OkmError("OKM1914", "A managed role has an attribute this config does not allow.", {
      kind: "forbidden",
      fix: {
        summary:
          "The role was not changed. Remove the excess attribute outside okmodel, or declare bypassRls with a reason.",
      },
    });
  }
  return {
    text: `${text}\n`,
    data: { roles: status.rows, failed: status.failed },
    warnings: [],
    outFile: null,
  };
}
