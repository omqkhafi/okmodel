/**
 * JSON Schema for each command's envelope `data`.
 *
 * `okm schema` prints these documents. The files under `schemas/cli-1/` are
 * the same bytes.
 */

import { ERROR_CATEGORIES, ERROR_KINDS } from "../../contracts/error.js";
import { UNTRUSTED_ORIGINS } from "../untrusted.js";
import { COMMANDS } from "./spec.js";

/** A JSON Schema document this module can check. */
export type JsonSchema = {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
  readonly type?: string | readonly string[];
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly const?: string | boolean;
  readonly enum?: readonly string[];
  readonly description?: string;
};

type JsonSchemaNode = {
  readonly type?: string | readonly string[];
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly const?: string | boolean;
  readonly enum?: readonly string[];
  readonly description?: string;
};

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

const textData = (id: string, title: string): JsonSchema => ({
  $schema: DRAFT,
  $id: id,
  title,
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" } },
});

const SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  build: object("build", "okm build data", ["directory"], {
    directory: { type: "string" },
    emulation: { type: "string", description: "Emulated features, when the schema uses any." },
  }),
  "catalog export": {
    $schema: DRAFT,
    $id: idOf("catalog export"),
    title: "okm catalog export data",
    description: "The snapshot, or an empty object when --out wrote the bytes to a file.",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["format", "logical", "catalogHash", "tables"],
        properties: {
          format: { type: "number" },
          logical: {
            type: "object",
            additionalProperties: false,
            required: ["namespace", "name", "format"],
            properties: {
              namespace: { type: "string" },
              name: { type: "string" },
              format: { type: "number" },
            },
          },
          catalogHash: { type: "string" },
          database: { type: "string" },
          tables: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["namespace", "name", "columns"],
              properties: {
                namespace: { type: "string" },
                name: { type: "string" },
                columns: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "type", "nullable"],
                    properties: {
                      name: { type: "string" },
                      type: { type: "string" },
                      nullable: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      { type: "object", additionalProperties: false, properties: {} },
    ],
  },
  check: object("check", "okm check data", ["status"], {
    status: { const: "ok" },
    notice: { type: "string" },
    emulation: { type: "string" },
  }),
  dev: textData(idOf("dev"), "okm dev data"),
  doctor: {
    $schema: DRAFT,
    $id: idOf("doctor"),
    title: "okm doctor data",
    oneOf: [
      objectNode(["code", "title", "summary", "fix"], {
        code: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        fix: { type: "string" },
        safeAlternatives: alternativesSchema(),
        docs: { type: "string" },
        escapeHatches: hatchesSchema(),
      }),
      objectNode(["text"], { text: { type: "string" } }),
    ],
  },
  "driver test": textData(idOf("driver test"), "okm driver test data"),
  "ext list": textData(idOf("ext list"), "okm ext list data"),
  "ext check": textData(idOf("ext check"), "okm ext check data"),
  "ext scaffold": textData(idOf("ext scaffold"), "okm ext scaffold data"),
  "ext test": textData(idOf("ext test"), "okm ext test data"),
  generate: object("generate", "okm generate data", ["path"], {
    path: { type: ["string", "null"] },
  }),
  "import drizzle": textData(idOf("import drizzle"), "okm import drizzle data"),
  "migrate plan": {
    $schema: DRAFT,
    $id: idOf("migrate plan"),
    title: "okm migrate plan data",
    type: "object",
    additionalProperties: false,
    required: [
      "name",
      "class",
      "operationClass",
      "fromCatalogHash",
      "toCatalogHash",
      "planHash",
      "requiresAck",
      "steps",
      "destructiveOperations",
      "findings",
    ],
    properties: {
      name: { type: "string" },
      class: { enum: ["expand", "contract", "unclassified"] },
      operationClass: operationClassSchema(),
      fromCatalogHash: { type: "string" },
      toCatalogHash: { type: "string" },
      planHash: { type: "string" },
      requiresAck: { type: "boolean" },
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["class", "operationClass", "lock", "sql"],
          properties: {
            class: { enum: ["expand", "contract", "unclassified"] },
            operationClass: operationClassSchema(),
            lock: { type: "string" },
            sql: { type: "string" },
          },
        },
      },
      destructiveOperations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["stepIndex", "kind", "objectKind", "name", "summary"],
          properties: {
            stepIndex: { type: "number" },
            kind: { type: "string" },
            objectKind: { type: "string" },
            name: { oneOf: [{ type: "string" }, untrustedSchema()] },
            summary: { type: "string" },
          },
        },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "code", "place", "reason", "fix"],
          properties: {
            severity: { enum: ["error", "warning"] },
            code: { type: "string" },
            place: { type: "string" },
            reason: untrustedSchema(),
            fix: { type: "string" },
          },
        },
      },
    },
  },
  "migrate apply": textData(idOf("migrate apply"), "okm migrate apply data"),
  "migrate status": object("migrate status", "okm migrate status data", ["text", "steps"], {
    text: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "state", "attempt", "nextAction"],
        properties: {
          id: untrustedSchema(),
          kind: untrustedSchema(),
          state: untrustedSchema(),
          attempt: { type: "number" },
          nextAction: { type: "string" },
        },
      },
    },
  }),
  "migrate resolve": object(
    "migrate resolve",
    "okm migrate resolve data",
    ["target", "step", "action", "result"],
    {
      target: { type: "string" },
      step: { type: "string" },
      action: { enum: ["applied", "retry"] },
      result: { enum: ["recorded", "retry"] },
    },
  ),
  "migrate check": textData(idOf("migrate check"), "okm migrate check data"),
  "migrate baseline": object(
    "migrate baseline",
    "okm migrate baseline data",
    ["target", "migrationId", "catalogHash", "status", "unmanaged"],
    {
      target: { type: "string" },
      migrationId: { type: "string" },
      catalogHash: { type: "string" },
      status: { enum: ["baselined", "already-baselined", "dry-run"] },
      unmanaged: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "name"],
          properties: {
            kind: { type: "string" },
            name: untrustedSchema(),
          },
        },
      },
    },
  ),
  push: textData(idOf("push"), "okm push data"),
  pull: textData(idOf("pull"), "okm pull data"),
  seed: textData(idOf("seed"), "okm seed data"),
  "protect add": object("protect add", "okm protect add data", ["hostDb", "identity", "reason"], {
    hostDb: { type: "string" },
    identity: { type: "null" },
    reason: { const: "store fingerprint" },
  }),
  "protect remove": object(
    "protect remove",
    "okm protect remove data",
    ["hostDb", "identity", "removed"],
    {
      hostDb: { type: "string" },
      identity: { type: "null" },
      removed: { type: "boolean" },
    },
  ),
  "protect list": object("protect list", "okm protect list data", ["fingerprints"], {
    fingerprints: {
      type: "array",
      items: objectNode(["hostDb", "identity"], {
        hostDb: { type: "string" },
        identity: { type: "null" },
      }),
    },
  }),
  schema: {
    $schema: DRAFT,
    $id: idOf("schema"),
    title: "okm schema data",
    type: "object",
    additionalProperties: true,
    required: ["$schema", "$id", "title"],
    properties: {
      $schema: { type: "string" },
      $id: { type: "string" },
      title: { type: "string" },
    },
  },
  init: object(
    "init",
    "okm init data",
    ["status", "detection", "files", "packageEdits", "nextSteps", "planHash", "install"],
    {
      status: { enum: ["planned", "applied", "unchanged"] },
      detection: objectNode(
        [
          "pm",
          "driver",
          "runtime",
          "databaseEnv",
          "git",
          "okmodel",
          "typescript",
          "orm",
          "ancestorConfig",
        ],
        {
          pm: { enum: ["bun", "pnpm", "yarn", "npm"] },
          driver: { enum: ["postgresjs", "pg", "bun-sql", "pglite", "neon"] },
          runtime: { enum: ["bun", "workers", "next", "node"] },
          packageName: untrustedSchema(),
          databaseEnv: { const: "DATABASE_URL" },
          git: { type: "boolean" },
          okmodel: { type: "boolean" },
          typescript: { enum: ["absent", "ok", "warn"] },
          orm: { type: "array", items: { type: "string" } },
          ancestorConfig: { type: "boolean" },
        },
      ),
      files: {
        type: "array",
        items: objectNode(["path", "state", "action"], {
          path: { type: "string" },
          state: { enum: ["absent", "identical", "managed-diff", "user-modified"] },
          action: { enum: ["create", "update", "skip", "overwrite", "append"] },
          diff: { type: "string" },
        }),
      },
      packageEdits: {
        type: "array",
        items: objectNode(["key", "action"], {
          key: { type: "string" },
          action: { enum: ["add", "skip"] },
          value: { type: "string" },
        }),
      },
      nextSteps: { type: "array", items: { type: "string" } },
      planHash: { type: "string" },
      install: { type: "boolean" },
      note: { type: "string" },
    },
  ),
};

/**
 * JSON Schema for one command's `data`.
 *
 * @param command - Command id, such as `migrate plan`
 * @returns The schema document
 */
export function schemaFor(command: string): JsonSchema {
  const found = SCHEMAS[command];
  if (found === undefined) {
    throw new Error(`No JSON Schema for ${command}.`);
  }
  return found;
}

/**
 * Pretty JSON `okm schema` prints for one command.
 *
 * @param command - Command id
 * @returns JSON text ending in a newline
 */
export function schemaText(command: string): string {
  return `${JSON.stringify(schemaFor(command), null, 2)}\n`;
}

/**
 * File name under `schemas/cli-1/` for one command.
 *
 * @param command - Command id
 * @returns The file name
 */
export function schemaFileName(command: string): string {
  return `${command.replaceAll(" ", "-")}.json`;
}

/**
 * Every command that has a data schema, in id order.
 *
 * @returns Command ids
 */
export function schemaCommands(): readonly string[] {
  return Object.keys(SCHEMAS).sort();
}

/**
 * JSON Schema for the envelope `errors` array.
 *
 * The six original fields are required. Location, `fixEdit`, alternatives,
 * `docs`, and hatches are optional.
 *
 * @returns The schema document
 */
export function errorsSchema(): JsonSchema {
  return {
    $schema: DRAFT,
    $id: "https://okmodel.dev/schemas/cli-1/errors.json",
    title: "okm.cli/1 errors",
    type: "array",
    items: errorItemSchema(),
  };
}

/**
 * Pretty JSON for {@link errorsSchema}.
 *
 * @returns JSON text ending in a newline
 */
export function errorsSchemaText(): string {
  return `${JSON.stringify(errorsSchema(), null, 2)}\n`;
}

/**
 * Reasons `value` does not match `schema`. Empty when it matches.
 *
 * The checker covers the keywords this module emits.
 *
 * @param schema - Schema from {@link schemaFor}
 * @param value - Candidate `data`
 * @returns Problem lines
 */
export function schemaProblems(schema: JsonSchemaNode, value: unknown): readonly string[] {
  return problemsAt(schema, value, "$");
}

/**
 * Whether every command spec has a schema and every schema has a spec.
 *
 * @returns Problem lines. Empty when the two lists match
 */
export function schemaCoverageProblems(): readonly string[] {
  const specs = new Set(COMMANDS.map((command) => command.id));
  const problems: string[] = [];
  for (const id of specs) {
    if (SCHEMAS[id] === undefined) problems.push(`missing schema for ${id}`);
  }
  for (const id of Object.keys(SCHEMAS)) {
    if (!specs.has(id)) problems.push(`schema without a command: ${id}`);
  }
  return problems;
}

function idOf(command: string): string {
  return `https://okmodel.dev/schemas/cli-1/${schemaFileName(command)}`;
}

function object(
  command: string,
  title: string,
  required: readonly string[],
  properties: Readonly<Record<string, JsonSchemaNode>>,
): JsonSchema {
  return {
    $schema: DRAFT,
    $id: idOf(command),
    title,
    ...objectNode(required, properties),
  };
}

function objectNode(
  required: readonly string[],
  properties: Readonly<Record<string, JsonSchemaNode>>,
): JsonSchemaNode {
  return { type: "object", additionalProperties: false, required, properties };
}

function errorItemSchema(): JsonSchemaNode {
  return objectNode(["code", "kind", "category", "summary", "fix", "retryable"], {
    code: { type: "string" },
    kind: { enum: ERROR_KINDS },
    category: { enum: ERROR_CATEGORIES },
    summary: { type: "string" },
    fix: { type: "string" },
    retryable: { type: "boolean" },
    location: objectNode([], {
      file: { type: "string" },
      line: { type: "number" },
      step: { type: "string" },
    }),
    fixEdit: {
      oneOf: [
        objectNode(["file", "insert"], { file: { type: "string" }, insert: { type: "string" } }),
        objectNode(["file", "replace"], { file: { type: "string" }, replace: { type: "string" } }),
      ],
    },
    safeAlternatives: alternativesSchema(),
    docs: { type: "string" },
    escapeHatches: hatchesSchema(),
    detail: untrustedSchema(),
  });
}

function operationClassSchema(): JsonSchemaNode {
  return { enum: ["additive", "widening", "data", "destructive"] };
}

function untrustedSchema(): JsonSchemaNode {
  return objectNode(["untrusted", "origin", "text", "truncated", "modified"], {
    untrusted: { const: true },
    origin: { enum: UNTRUSTED_ORIGINS },
    text: { type: "string" },
    truncated: { type: "boolean" },
    modified: { type: "boolean" },
  });
}

function alternativesSchema(): JsonSchemaNode {
  return {
    type: "array",
    items: objectNode(["text", "docs"], { text: { type: "string" }, docs: { type: "string" } }),
  };
}

function hatchesSchema(): JsonSchemaNode {
  return {
    type: "array",
    items: objectNode(["name", "requiresHumanReason", "docs"], {
      name: { type: "string" },
      requiresHumanReason: { const: true },
      docs: { type: "string" },
    }),
  };
}

function problemsAt(schema: JsonSchemaNode, value: unknown, path: string): readonly string[] {
  if (schema.oneOf !== undefined) {
    const hits = schema.oneOf.filter((branch) => problemsAt(branch, value, path).length === 0);
    if (hits.length === 1) return [];
    return [`${path} matched ${String(hits.length)} oneOf branches`];
  }
  if (schema.const !== undefined) {
    return value === schema.const ? [] : [`${path} must be ${schema.const}`];
  }
  if (schema.enum !== undefined) {
    return schema.enum.some((item) => item === value) ? [] : [`${path} is not an allowed value`];
  }
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    return [`${path} has the wrong type`];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (schema.items !== undefined) {
      if (!Array.isArray(value)) return [`${path} must be an array`];
      const problems: string[] = [];
      value.forEach((item, index) => {
        problems.push(...problemsAt(schema.items ?? {}, item, `${path}[${String(index)}]`));
      });
      return problems;
    }
    return [];
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in record)) problems.push(`${path}.${key} is required`);
  }
  if (schema.additionalProperties === false && schema.properties !== undefined) {
    for (const key of Object.keys(record)) {
      if (schema.properties[key] === undefined) problems.push(`${path}.${key} is not allowed`);
    }
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (!(key in record)) continue;
    problems.push(...problemsAt(child, record[key], `${path}.${key}`));
  }
  return problems;
}

function typeMatches(type: string | readonly string[], value: unknown): boolean {
  const types = typeof type === "string" ? [type] : type;
  return types.some((item) => {
    if (item === "null") return value === null;
    if (item === "array") return Array.isArray(value);
    if (item === "object")
      return typeof value === "object" && value !== null && !Array.isArray(value);
    if (item === "number") return typeof value === "number";
    if (item === "string") return typeof value === "string";
    if (item === "boolean") return typeof value === "boolean";
    return false;
  });
}
