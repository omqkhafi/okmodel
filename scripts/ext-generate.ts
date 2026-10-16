/**
 * Generates the M2 extension packs.
 *
 * The naming overlay in this file is hand-written. Versions are the
 * `default_version` of each contrib control file on `REL_15_STABLE` through
 * `REL_18_STABLE`. A connected server is the drift check: `bun test`
 * `tests/ext-builtins-pg.test.ts` compares this table and the method
 * signatures with that server. Users do not run this script.
 *
 * `vector` is not generated. The CI topology images are `postgres:15` through
 * `postgres:18`, which do not ship pgvector, and this script does not add a
 * service to that topology (D279).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

/** Postgres majors the registry records. */
const MAJORS = [15, 16, 17, 18] as const;

/** One major's default extension version. */
type Versions = {
  readonly 15: string;
  readonly 16: string;
  readonly 17: string;
  readonly 18: string;
};

/** A where-function that compares `fn(column)` with `fn($1)`. */
type FnEq = {
  readonly kind: "fn-eq";
  readonly ts: string;
  readonly sql: string;
  readonly doc: string;
};

/** A boolean operator on the column. */
type Op = {
  readonly kind: "op";
  readonly ts: string;
  readonly op: string;
  readonly cast?: string;
  readonly doc: string;
};

/** `fn(column, $1) = distance`. */
type Distance = {
  readonly kind: "distance";
  readonly ts: string;
  readonly sql: string;
  readonly doc: string;
};

/** `encode(digest(column, $1), 'hex') = $2`. */
type Digest = {
  readonly kind: "digest";
  readonly ts: string;
  readonly doc: string;
};

/** An index method. */
type IndexMethod = {
  readonly kind: "index";
  readonly ts: string;
  readonly method: "gin" | "gist";
  readonly opclass: string;
  readonly doc: string;
};

/** A function that exists only from one extension version and major. */
type Gated = {
  readonly kind: "gated";
  readonly ts: string;
  readonly sql: string;
  readonly extension: string;
  readonly postgres: number;
  readonly doc: string;
};

/** One method the overlay names. */
type Method = FnEq | Op | Distance | Digest | IndexMethod | Gated;

/** One pack the generator writes. */
type Pack = {
  readonly name: string;
  readonly file: string;
  readonly exportName: string;
  readonly typeName: string;
  readonly versions: Versions;
  readonly minPostgres: 15;
  readonly summary: string;
  readonly methods: readonly Method[];
  /** Signatures the drift check looks up. Present on every supported major. */
  readonly signatures: readonly Signature[];
};

/** One catalog object the drift check requires. */
type Signature =
  | { readonly kind: "function"; readonly name: string; readonly args: string }
  | {
      readonly kind: "operator";
      readonly name: string;
      readonly left: string;
      readonly right: string;
    }
  | { readonly kind: "opclass"; readonly name: string; readonly method: string };

const PACKS: readonly Pack[] = [
  {
    name: "unaccent",
    file: "unaccent.ts",
    exportName: "unaccent",
    typeName: "Unaccent",
    versions: { 15: "1.1", 16: "1.1", 17: "1.1", 18: "1.1" },
    minPostgres: 15,
    summary: "The `unaccent` extension. `unaccent` folds accents on a text column.",
    methods: [
      {
        kind: "fn-eq",
        ts: "unaccent",
        sql: "unaccent",
        doc: "`unaccent(column) = unaccent(value)`.",
      },
    ],
    signatures: [{ kind: "function", name: "unaccent", args: "text" }],
  },
  {
    name: "hstore",
    file: "hstore.ts",
    exportName: "hstore",
    typeName: "Hstore",
    versions: { 15: "1.8", 16: "1.8", 17: "1.8", 18: "1.8" },
    minPostgres: 15,
    summary: "The `hstore` extension. `hasKey` is `?`. `gin` and `gist` index an hstore column.",
    methods: [
      { kind: "op", ts: "hasKey", op: "?", doc: "`column ? key`." },
      {
        kind: "index",
        ts: "gin",
        method: "gin",
        opclass: "gin_hstore_ops",
        doc: "A GIN index with `gin_hstore_ops`.",
      },
      {
        kind: "index",
        ts: "gist",
        method: "gist",
        opclass: "gist_hstore_ops",
        doc: "A GiST index with `gist_hstore_ops`.",
      },
    ],
    signatures: [
      { kind: "operator", name: "?", left: "hstore", right: "text" },
      { kind: "function", name: "akeys", args: "hstore" },
      { kind: "opclass", name: "gin_hstore_ops", method: "gin" },
      { kind: "opclass", name: "gist_hstore_ops", method: "gist" },
    ],
  },
  {
    name: "ltree",
    file: "ltree.ts",
    exportName: "ltree",
    typeName: "Ltree",
    versions: { 15: "1.2", 16: "1.2", 17: "1.3", 18: "1.3" },
    minPostgres: 15,
    summary:
      "The `ltree` extension. `ancestorOf` is `@>` and `descendantOf` is `<@`. This is not the parent-column walk.",
    methods: [
      {
        kind: "op",
        ts: "ancestorOf",
        op: "@>",
        cast: "ltree",
        doc: "`column @> path`. The column is an ancestor of `path`.",
      },
      {
        kind: "op",
        ts: "descendantOf",
        op: "<@",
        cast: "ltree",
        doc: "`column <@ path`. The column is a descendant of `path`.",
      },
      {
        kind: "index",
        ts: "gist",
        method: "gist",
        opclass: "gist_ltree_ops",
        doc: "A GiST index with `gist_ltree_ops`.",
      },
    ],
    signatures: [
      { kind: "operator", name: "@>", left: "ltree", right: "ltree" },
      { kind: "operator", name: "<@", left: "ltree", right: "ltree" },
      { kind: "opclass", name: "gist_ltree_ops", method: "gist" },
    ],
  },
  {
    name: "btree_gist",
    file: "btree-gist.ts",
    exportName: "btreeGist",
    typeName: "BtreeGist",
    versions: { 15: "1.7", 16: "1.7", 17: "1.7", 18: "1.8" },
    minPostgres: 15,
    summary:
      "The `btree_gist` extension. `gist` stores a GiST operator class so an exclude constraint can use `=`.",
    methods: [
      {
        kind: "index",
        ts: "gist",
        method: "gist",
        opclass: "gist_int4_ops",
        doc: "A GiST index with `gist_int4_ops`.",
      },
    ],
    signatures: [{ kind: "opclass", name: "gist_int4_ops", method: "gist" }],
  },
  {
    name: "btree_gin",
    file: "btree-gin.ts",
    exportName: "btreeGin",
    typeName: "BtreeGin",
    versions: { 15: "1.3", 16: "1.3", 17: "1.3", 18: "1.3" },
    minPostgres: 15,
    summary: "The `btree_gin` extension. `gin` stores a GIN operator class for scalar equality.",
    methods: [
      {
        kind: "index",
        ts: "gin",
        method: "gin",
        opclass: "int4_ops",
        doc: "A GIN index with `int4_ops`.",
      },
    ],
    signatures: [{ kind: "opclass", name: "int4_ops", method: "gin" }],
  },
  {
    name: "fuzzystrmatch",
    file: "fuzzystrmatch.ts",
    exportName: "fuzzystrmatch",
    typeName: "Fuzzystrmatch",
    versions: { 15: "1.1", 16: "1.2", 17: "1.2", 18: "1.2" },
    minPostgres: 15,
    summary:
      "The `fuzzystrmatch` extension. `levenshtein` compares edit distance. `daitchMokotoff` needs version 1.2 and PostgreSQL 16.",
    methods: [
      {
        kind: "distance",
        ts: "levenshtein",
        sql: "levenshtein",
        doc: "`levenshtein(column, value) = distance`.",
      },
      {
        kind: "gated",
        ts: "daitchMokotoff",
        sql: "daitch_mokotoff",
        extension: "1.2",
        postgres: 16,
        doc: "`daitch_mokotoff(column) = daitch_mokotoff(value)`. Needs fuzzystrmatch 1.2 and PostgreSQL 16.",
      },
    ],
    signatures: [{ kind: "function", name: "levenshtein", args: "text, text" }],
  },
  {
    name: "pgcrypto",
    file: "pgcrypto.ts",
    exportName: "pgcrypto",
    typeName: "Pgcrypto",
    versions: { 15: "1.3", 16: "1.3", 17: "1.3", 18: "1.4" },
    minPostgres: 15,
    summary:
      "The `pgcrypto` extension. `digest` compares a hex digest. `fipsMode` needs version 1.4 and PostgreSQL 18.",
    methods: [
      { kind: "digest", ts: "digest", doc: "`encode(digest(column, algorithm), 'hex') = hex`." },
      {
        kind: "gated",
        ts: "fipsMode",
        sql: "fips_mode",
        extension: "1.4",
        postgres: 18,
        doc: "`fips_mode()` is true or false on the column's row. Needs pgcrypto 1.4 and PostgreSQL 18.",
      },
    ],
    signatures: [{ kind: "function", name: "digest", args: "text, text" }],
  },
];

/**
 * Versions and drift signatures, written next to the packs.
 *
 * The postgres test imports this module. The packs do not, so a subpath does
 * not pull the whole table.
 */
function versionsModule(): string {
  const body = PACKS.map((pack) => {
    const versions = MAJORS.map(
      (major) => `${String(major)}: ${JSON.stringify(pack.versions[major])}`,
    ).join(", ");
    const signatures = pack.signatures
      .map((signature) => `    ${JSON.stringify(signature)},`)
      .join("\n");
    return `  {
    name: ${JSON.stringify(pack.name)},
    versions: { ${versions} },
    minPostgres: 15,
    signatures: [
${signatures}
    ],
  },`;
  }).join("\n");
  return `/**
 * Default versions and drift signatures for the generated packs.
 *
 * Generated by scripts/ext-generate.ts. Do not edit.
 * Versions are the control-file default on each supported major.
 */

/** One object the drift check requires on the connected server. */
export type ExtSignature =
  | { readonly kind: "function"; readonly name: string; readonly args: string }
  | {
      readonly kind: "operator";
      readonly name: string;
      readonly left: string;
      readonly right: string;
    }
  | { readonly kind: "opclass"; readonly name: string; readonly method: string };

/** One generated pack's versions and the objects the drift check names. */
export type ExtPackRecord = {
  readonly name: string;
  readonly versions: { readonly 15: string; readonly 16: string; readonly 17: string; readonly 18: string };
  /** Oldest major the base methods exist on. */
  readonly minPostgres: 15;
  readonly signatures: readonly ExtSignature[];
};

/** Packs this version generates. \`vector\` is not in the list (D279). */
export const EXT_PACKS: readonly ExtPackRecord[] = [
${body}
];
`;
}

function packModule(pack: Pack): string {
  const methods = pack.methods.map((method) => methodField(method)).join("\n");
  const impl = pack.methods.map((method) => methodImpl(pack, method)).join("\n");
  const call = importsFor(pack);
  const typeImports = [
    pack.methods.some((method) => method.kind !== "index")
      ? 'import type { Fragment } from "../ops/fragment.js";'
      : "",
    pack.methods.some((method) => method.kind === "index")
      ? 'import type { IndexCall } from "../table.js";'
      : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  return `/**
 * ${pack.summary}
 *
 * Generated by scripts/ext-generate.ts. Do not edit.
 * \`minPostgres\` for the base methods is ${String(pack.minPostgres)}. A feature
 * a declared version lacks fails with OKM1812.
 */

${typeImports}
${call.length > 0 ? `import { ${call} } from "./call.js";` : ""}
import { extension, type Extension, type ExtensionOptions } from "./index.js";
${pack.methods.some((method) => method.kind === "gated") ? 'import { assertExtFeature } from "./feature.js";' : ""}
${pack.methods.some((method) => method.kind === "index") ? 'import { usingIndex } from "./using.js";' : ""}
/** \`${pack.name}\` plus the methods the naming overlay selected. */
export type ${pack.typeName} = Extension & {
${methods}
};

/**
 * Declares \`${pack.name}\`.
 *
 * @param options - Schema and version pin
 * @returns The extension object and its methods
 */
export function ${pack.exportName}(options: ExtensionOptions = {}): ${pack.typeName} {
  const declared = extension(${JSON.stringify(pack.name)}, options);
${usesSchema(pack) ? "  const schema = declared.schema;\n" : ""}  return {
    ...declared,
${impl}
  };
}
`;
}

function usesSchema(pack: Pack): boolean {
  return pack.methods.some(
    (method) =>
      method.kind === "fn-eq" ||
      method.kind === "distance" ||
      method.kind === "digest" ||
      method.kind === "gated",
  );
}

function importsFor(pack: Pack): string {
  const names = new Set<string>();
  for (const method of pack.methods) {
    if (method.kind === "fn-eq") names.add("fnEqualsArg");
    if (method.kind === "gated" && method.sql !== "fips_mode") names.add("fnEqualsArg");
    if (method.kind === "gated" && method.sql === "fips_mode") names.add("bareCall");
    if (method.kind === "distance") names.add("fnDistance");
    if (method.kind === "op") names.add("opArg");
    if (method.kind === "digest") names.add("digestEquals");
  }
  return [...names].sort().join(", ");
}

function methodField(method: Method): string {
  const signature = methodSignature(method);
  const params = paramDocs(method);
  const paramBlock = params.length === 0 ? "" : `\n   * ${params}`;
  return `  /**
   * ${method.doc}
   *${paramBlock}
   * @returns ${method.kind === "index" ? "An index call whose expression is the `using` tail" : "A where fragment"}
   */
  ${method.ts}${signature};`;
}

function methodSignature(method: Method): string {
  if (method.kind === "index") return "(column: string): IndexCall";
  if (method.kind === "distance") return "(value: string, distance: number): Fragment";
  if (method.kind === "digest") return "(algorithm: string, hex: string): Fragment";
  if (method.kind === "gated" && method.sql === "fips_mode") return "(): Fragment";
  return "(value: string): Fragment";
}

function paramDocs(method: Method): string {
  if (method.kind === "index") return "@param column - SQL column name";
  if (method.kind === "distance") {
    return "@param value - Text to compare\n   * @param distance - Edit distance the function must return";
  }
  if (method.kind === "digest") {
    return "@param algorithm - Digest algorithm, such as `sha256`\n   * @param hex - Expected hex digest";
  }
  if (method.kind === "gated" && method.sql === "fips_mode") return "";
  return "@param value - Text to compare";
}

function methodImpl(pack: Pack, method: Method): string {
  if (method.kind === "index") {
    return `    ${method.ts}(column: string): IndexCall {
      return usingIndex(column, ${JSON.stringify(method.method)}, ${JSON.stringify(method.opclass)});
    },`;
  }
  if (method.kind === "fn-eq") {
    return `    ${method.ts}(value: string): Fragment {
      return fnEqualsArg(schema, ${JSON.stringify(method.sql)}, value);
    },`;
  }
  if (method.kind === "op") {
    const cast = method.cast === undefined ? "" : `, ${JSON.stringify(method.cast)}`;
    return `    ${method.ts}(value: string): Fragment {
      return opArg(${JSON.stringify(method.op)}, value${cast});
    },`;
  }
  if (method.kind === "distance") {
    return `    ${method.ts}(value: string, distance: number): Fragment {
      return fnDistance(schema, ${JSON.stringify(method.sql)}, value, distance);
    },`;
  }
  if (method.kind === "digest") {
    return `    ${method.ts}(algorithm: string, hex: string): Fragment {
      return digestEquals(schema, algorithm, hex);
    },`;
  }
  if (method.sql === "fips_mode") {
    return `    ${method.ts}(): Fragment {
      assertExtFeature(options.version, ${JSON.stringify(method.sql)}, {
        name: ${JSON.stringify(pack.name)},
        extension: ${JSON.stringify(method.extension)},
        postgres: ${String(method.postgres)},
      });
      return bareCall(schema, ${JSON.stringify(method.sql)});
    },`;
  }
  return `    ${method.ts}(value: string): Fragment {
      assertExtFeature(options.version, ${JSON.stringify(method.sql)}, {
        name: ${JSON.stringify(pack.name)},
        extension: ${JSON.stringify(method.extension)},
        postgres: ${String(method.postgres)},
      });
      return fnEqualsArg(schema, ${JSON.stringify(method.sql)}, value);
    },`;
}

function compatibilityDoc(): string {
  const header = MAJORS.map((major) => `Postgres ${String(major)}`).join(" | ");
  const rule = MAJORS.map(() => "---").join(" | ");
  const rows = PACKS.map((pack) => {
    const cells = MAJORS.map((major) => pack.versions[major]).join(" | ");
    return `| \`${pack.name}\` | ${cells} |`;
  }).join("\n");
  return `# Extension compatibility

Generated by \`scripts/ext-generate.ts\` from the contrib control files on the \`REL_15_STABLE\` through \`REL_18_STABLE\` branches. The number is \`default_version\`. The drift check compares it with the connected server.

\`vector\` is not in this table. The CI images are official \`postgres\` images, which do not ship pgvector (D279).

| Extension | ${header} |
| --- | ${rule} |
${rows}
`;
}

/**
 * Writes the packs, the version module, and the compatibility table.
 */
function emit(): void {
  const root = repoRoot();
  const dir = join(root, "src/dialects/pg/ext");
  for (const pack of PACKS) {
    writeFileSync(join(dir, pack.file), packModule(pack));
  }
  writeFileSync(join(dir, "versions.ts"), versionsModule());
  writeFileSync(join(root, "docs/extension-compatibility.md"), compatibilityDoc());
}

if (import.meta.main) emit();
