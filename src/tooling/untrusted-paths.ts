/**
 * Where command JSON can carry text that did not come from OKModel.
 *
 * `object` is an {@link UntrustedText} value. `text` is a human blob this
 * change leaves as a string. `execution` is SQL the plan hash must store
 * exactly as it will run. `none` carries no database or user text.
 */

import type { UntrustedOrigin } from "./untrusted.js";

/** How one output path treats text. */
export type UntrustedTreatment = "object" | "text" | "execution" | "none";

/** One JSON path a command can print. */
export type UntrustedPath = {
  readonly command: string;
  readonly path: string;
  readonly treatment: UntrustedTreatment;
  readonly origin?: UntrustedOrigin;
};

/**
 * Output paths and the commands that have no database text.
 *
 * Every command id in the CLI table appears once at least.
 */
export const UNTRUSTED_PATHS: readonly UntrustedPath[] = [
  {
    command: "errors",
    path: "errors[].detail",
    treatment: "object",
    origin: "db.error",
  },
  {
    command: "migrate plan",
    path: "data.findings[].reason",
    treatment: "object",
    origin: "user.query",
  },
  {
    command: "migrate plan",
    path: "data.destructiveOperations[].name",
    treatment: "object",
    origin: "schema.identifier",
  },
  {
    command: "migrate plan",
    path: "data.steps[].sql",
    treatment: "execution",
  },
  { command: "migrate apply", path: "data.text", treatment: "text" },
  {
    command: "migrate status",
    path: "data.steps[].id",
    treatment: "object",
    origin: "db.object-name",
  },
  {
    command: "migrate status",
    path: "data.steps[].kind",
    treatment: "object",
    origin: "db.object-name",
  },
  {
    command: "migrate status",
    path: "data.steps[].state",
    treatment: "object",
    origin: "db.object-name",
  },
  { command: "migrate status", path: "data.text", treatment: "text" },
  { command: "migrate resolve", path: "data.step", treatment: "none" },
  { command: "migrate check", path: "data.text", treatment: "text" },
  {
    command: "migrate baseline",
    path: "data.unmanaged[].name",
    treatment: "object",
    origin: "db.object-name",
  },
  { command: "catalog export", path: "data", treatment: "text" },
  { command: "import drizzle", path: "data.text", treatment: "text" },
  { command: "driver test", path: "data.text", treatment: "text" },
  { command: "ext scaffold", path: "data.text", treatment: "text" },
  { command: "ext check", path: "data.text", treatment: "text" },
  { command: "ext list", path: "data.text", treatment: "text" },
  { command: "ext test", path: "data.text", treatment: "text" },
  { command: "build", path: "data", treatment: "none" },
  { command: "check", path: "data", treatment: "none" },
  { command: "dev", path: "data.text", treatment: "text" },
  { command: "doctor", path: "data.text", treatment: "text" },
  { command: "generate", path: "data.path", treatment: "none" },
  { command: "push", path: "data.text", treatment: "text" },
  { command: "raw sync", path: "data.lock", treatment: "none" },
  { command: "pull", path: "data.text", treatment: "text" },
  { command: "seed", path: "data.text", treatment: "text" },
  { command: "protect add", path: "data.hostDb", treatment: "none" },
  { command: "protect remove", path: "data.hostDb", treatment: "none" },
  { command: "protect list", path: "data.fingerprints[].hostDb", treatment: "none" },
  { command: "schema", path: "data", treatment: "none" },
  { command: "agents status", path: "data", treatment: "none" },
  { command: "agents update", path: "data", treatment: "none" },
  { command: "agents remove", path: "data", treatment: "none" },
  {
    command: "init",
    path: "data.detection.packageName",
    treatment: "object",
    origin: "package.json",
  },
];
