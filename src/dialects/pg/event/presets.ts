/**
 * Event-trigger presets.
 *
 * Each one returns a declaration `schema({ triggers })` stores. The compiler
 * that builds the function and the trigger loads with this module.
 */

import { eventTriggerObject } from "../../../contracts/catalog/event-trigger.js";
import { OkmError } from "../../../contracts/error.js";
import { functionObject } from "../../../contracts/catalog/routine.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import type {
  CatalogObject,
  FunctionObject,
  Namespace,
  ObjectIdentity,
  Provenance,
} from "../../../contracts/catalog/types.js";
import { table, type AnyTable } from "../table.js";
import { t } from "../namespace.js";
import type { Names } from "../casing.js";
import { quoteIdent } from "../ddl.js";
import { quoteLiteral } from "../quote.js";
import type { EventCommandTag } from "./tags.js";
import { roleToken } from "./tags.js";

const PROVENANCE = (name: string): Provenance => ({ origin: "trait", name });

/** What {@link guardDdl} blocks. A list installs one trigger per entry. */
export type GuardBlock = "manual" | "drops" | "rewrites";

/** Options for {@link guardDdl}. */
export type GuardDdlOptions = {
  /** `manual` is a role boundary. `drops` and `rewrites` are a GUC belt. */
  readonly block: GuardBlock | readonly GuardBlock[];
  /**
   * Role keys allowed to run DDL when `block` is `manual`.
   *
   * Each key is a `roles` key, such as `migration`. Membership is
   * `pg_has_role(session_user, role, 'usage' | 'set')` on PostgreSQL 16 and
   * later, and `'member'` on 15. `SET ROLE` does not bypass it. A superuser passes.
   */
  readonly allow?: readonly string[];
  /**
   * Schemas the manual guard watches.
   *
   * `ddl_command_start` cannot see the object, so a list still refuses every
   * non-member. The end event is used when this is set, and a command whose
   * schema is outside the list is left alone.
   */
  readonly schemas?: readonly string[];
};

/** Options for {@link enableRls}. */
export type EnableRlsOptions = {
  /** Schemas whose new tables get `ENABLE ROW LEVEL SECURITY`. */
  readonly schemas: readonly string[];
};

/** Options for {@link auditDdl}. `keep` is a docs recipe, not an option. */
export type AuditDdlOptions = {
  /** Schema that holds the two tables. The default is `audit`. */
  readonly into?: string;
};

/** Options for {@link notifyDdl}. */
export type NotifyDdlOptions = {
  /** `pg_notify` channel. An identifier. */
  readonly channel: string;
  /** Command tags. Absent means every `ddl_command_end` tag. */
  readonly tags?: readonly EventCommandTag[];
  /**
   * Payload shape.
   *
   * The only shape is the command tag and the object identity, cut at 8000
   * bytes. Pass `"tag"` or omit it.
   */
  readonly payload?: "tag";
};

/** A preset declaration, plus the tables `auditDdl` exposes. */
export type PresetDeclaration = {
  readonly name: string;
  readonly rlsSchemas?: readonly string[];
  contribute(peers: unknown, built: CatalogObject[], names?: Names): readonly CatalogObject[];
};

/**
 * Refuses DDL that the session is not allowed to run.
 *
 * `manual` is the boundary: the session user must be a member of an `allow`
 * role. `drops` and `rewrites` are a belt. They pass when `okm apply` has set
 * `okm.allow_drop` or `okm.allow_rewrite` for that step. Any session can set
 * those, so they are not a privilege boundary. `DROP EVENT TRIGGER` is never
 * refused, so a bad guard can still be removed.
 *
 * @param options - What to block, and the roles a manual guard allows
 * @returns A trigger declaration
 */
export function guardDdl(options: GuardDdlOptions): PresetDeclaration {
  const blocks = Array.isArray(options.block) ? [...options.block] : [options.block];
  if (blocks.length === 0) {
    throw new OkmError("OKM1931", "guardDdl needs a block.", {
      fix: { summary: 'Pass "manual", "drops", "rewrites", or a list of those.' },
    });
  }
  for (const block of blocks) {
    if (block !== "manual" && block !== "drops" && block !== "rewrites") {
      throw new OkmError("OKM1931", `guardDdl block ${String(block)} is not supported.`, {
        fix: { summary: 'Use "manual", "drops", or "rewrites".' },
      });
    }
  }
  if (blocks.includes("manual") && (options.allow === undefined || options.allow.length === 0)) {
    throw new OkmError("OKM1931", "guardDdl manual needs allow.", {
      fix: { summary: 'Pass allow: ["migration"] or another roles key.' },
    });
  }
  const name = blocks.length === 1 ? `okm_guard_${blocks[0]}` : "okm_guard";
  return {
    name,
    contribute() {
      const out: CatalogObject[] = [];
      for (const block of blocks) {
        out.push(...guardPair(block, options));
      }
      return out;
    },
  };
}

/**
 * Enables row security on tables created in the named schemas.
 *
 * The trigger runs at `ddl_command_end` for `CREATE TABLE`, `CREATE TABLE AS`,
 * and `SELECT INTO`. It does not force row security. Extension objects and
 * temporary tables are skipped. Tables in those schemas default `rls` to
 * true, and `rls: false` there is OKM1931.
 *
 * @param options - Schemas to cover
 * @returns A trigger declaration
 */
export function enableRls(options: EnableRlsOptions): PresetDeclaration {
  if (options.schemas.length === 0) {
    throw new OkmError("OKM1931", "enableRls needs schemas.", {
      fix: { summary: 'Pass schemas: ["public"].' },
    });
  }
  return {
    name: "okm_enable_rls",
    rlsSchemas: options.schemas,
    contribute() {
      const body = enableBody(options.schemas);
      return pair(
        "okm_enable_rls",
        "enableRls",
        "ddl_command_end",
        ["CREATE TABLE", "CREATE TABLE AS", "SELECT INTO"],
        body,
        "public",
      );
    },
  };
}

/**
 * Records successful DDL in two tables.
 *
 * `transactions` is one row per transaction. `commands` is one row per
 * command. Put both in `schema({ tables })`. They are owned by the migration
 * role, and only the security-definer function writes them. `reporting`
 * receives `SELECT`. There is no scheduler: keep rows with the recipe in
 * the event-trigger docs.
 *
 * The client may set `okm.application_user`. That value is whatever the
 * client sends. It is not a proof of who ran the command.
 *
 * @param options - Schema name. The default is `audit`
 * @returns The declaration and the two tables
 */
export function auditDdl(options: AuditDdlOptions = {}): PresetDeclaration & {
  readonly transactions: AnyTable;
  readonly commands: AnyTable;
} {
  const schemaName = options.into ?? "audit";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName)) {
    throw new OkmError("OKM1931", `auditDdl schema ${schemaName} is not an identifier.`, {
      fix: { summary: "Pass an identifier, or omit into." },
    });
  }
  const transactions = table(
    "ddl_tx",
    {
      txid: t.text().primaryKey(),
      at: t.timestamptz(),
      actor: t.text(),
      app_name: t.text(),
      client_addr: t.inet().nullable(),
      query_text: t.text(),
      app_user: t.text().nullable(),
    },
    { grants: { reporting: "read" } },
  );
  const commands = table(
    "ddl_command",
    {
      id: t.identity(),
      txid: t.text(),
      command_tag: t.text(),
      object_type: t.text(),
      object_identity: t.text(),
      schema_name: t.text().nullable(),
      cascade: t.boolean(),
    },
    { grants: { reporting: "read" } },
  );
  return {
    name: "okm_audit_ddl",
    transactions,
    commands,
    contribute(_peers, built, names) {
      const tx = names?.table(transactions) ?? "ddl_tx";
      const cmd = names?.table(commands) ?? "ddl_command";
      pin(built, tx, schemaName);
      pin(built, cmd, schemaName);
      const col = (item: AnyTable, field: string): string =>
        quoteIdent(names?.column(item, field) ?? field);
      const body = auditBody(schemaName, tx, cmd, transactions, commands, col);
      return [
        auditFunction(schemaName, body),
        eventTriggerObject({
          name: "okm_audit_end",
          event: "ddl_command_end",
          calls: { namespace: staticNamespace(schemaName), name: "okm_audit_ddl", argTypes: [] },
          provenance: PROVENANCE("auditDdl"),
        }),
        eventTriggerObject({
          name: "okm_audit_drop",
          event: "sql_drop",
          calls: { namespace: staticNamespace(schemaName), name: "okm_audit_ddl", argTypes: [] },
          provenance: PROVENANCE("auditDdl"),
        }),
      ];
    },
  };
}

/**
 * Sends `pg_notify` after DDL.
 *
 * The payload is JSON `{ "tag", "object" }`, cut at 8000 bytes. PostgREST's
 * `NOTIFY pgrst, 'reload schema'` is a different payload. The docs show it
 * as its own function.
 *
 * @param options - Channel and optional tags
 * @returns A trigger declaration
 */
export function notifyDdl(options: NotifyDdlOptions): PresetDeclaration {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.channel)) {
    throw new OkmError("OKM1931", `notifyDdl channel ${options.channel} is not an identifier.`, {
      fix: { summary: "Pass a channel name such as schema_changed." },
    });
  }
  if (options.payload !== undefined && options.payload !== "tag") {
    throw new OkmError("OKM1931", "notifyDdl payload is the command tag and the object identity.", {
      fix: { summary: 'Omit payload, or pass payload: "tag".' },
    });
  }
  const tags = options.tags?.map((tag) => tag.trim().replace(/\s+/g, " ").toUpperCase());
  return {
    name: "okm_notify_ddl",
    contribute() {
      const body = [
        "declare cmd record;",
        "begin",
        "  for cmd in select * from pg_event_trigger_ddl_commands() loop",
        "    if cmd.in_extension then continue; end if;",
        `    perform pg_notify(${quoteLiteral(options.channel)}, left(json_build_object('tag', cmd.command_tag, 'object', cmd.object_identity)::text, 8000));`,
        "  end loop;",
        "end",
      ].join("\n");
      return pair("okm_notify_ddl", "notifyDdl", "ddl_command_end", tags, body, "public");
    },
  };
}

function guardPair(block: GuardBlock, options: GuardDdlOptions): readonly CatalogObject[] {
  const fn = `okm_guard_${block}`;
  if (block === "rewrites") {
    return pair(fn, "guardDdl", "table_rewrite", undefined, rewriteBody(), "public");
  }
  if (block === "drops") {
    return pair(fn, "guardDdl", "ddl_command_start", undefined, dropBody(), "public");
  }
  const schemas = options.schemas;
  const event =
    schemas !== undefined && schemas.length > 0 ? "ddl_command_end" : "ddl_command_start";
  return pair(fn, "guardDdl", event, undefined, manualBody(options.allow ?? [], schemas), "public");
}

function pair(
  name: string,
  preset: string,
  event: "ddl_command_start" | "ddl_command_end" | "sql_drop" | "table_rewrite",
  tags: readonly string[] | undefined,
  body: string,
  schemaName: string,
): readonly CatalogObject[] {
  const namespace = staticNamespace(schemaName);
  return [
    eventFunction(name, preset, namespace, body, schemaName === "public" ? undefined : "auditDdl"),
    eventTriggerObject({
      name,
      event,
      ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
      calls: { namespace, name, argTypes: [] },
      provenance: PROVENANCE(preset),
    }),
  ];
}

function eventFunction(
  name: string,
  preset: string,
  namespace: Namespace,
  body: string,
  pinName: string | undefined,
): FunctionObject {
  return functionObject({
    namespace,
    name,
    arguments: [],
    returns: "event_trigger",
    language: "plpgsql",
    volatility: "volatile",
    security: "invoker",
    searchPath: "pg_catalog, pg_temp",
    body,
    provenance: PROVENANCE(pinName ?? preset),
    dependencies: [],
  });
}

function manualBody(allow: readonly string[], schemas: readonly string[] | undefined): string {
  const role = (key: string, privilege: string): string =>
    `pg_has_role(session_user, '${roleToken(key)}', '${privilege}')`;
  const modern = allow.map((key) => `${role(key, "usage")} or ${role(key, "set")}`).join(" or ");
  const legacy = allow.map((key) => role(key, "member")).join(" or ");
  const checks = `current_setting('server_version_num')::int >= 160000 and (${modern}) or current_setting('server_version_num')::int < 160000 and (${legacy})`;
  const schemaGate =
    schemas === undefined || schemas.length === 0
      ? ""
      : `  if not exists (select 1 from pg_event_trigger_ddl_commands() c where c.schema_name in (${schemas.map((item) => quoteLiteral(item)).join(", ")})) then return; end if;\n`;
  return [
    "begin",
    "  if tg_tag = 'DROP EVENT TRIGGER' then return; end if;",
    schemaGate.trimEnd(),
    "  if exists (select 1 from pg_roles where rolname = session_user and rolsuper) then return; end if;",
    `  if ${checks} then return; end if;`,
    "  raise exception 'okm_guard_manual refuses % for %', tg_tag, session_user using errcode = '42501';",
    "end",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function dropBody(): string {
  return [
    "begin",
    "  if tg_tag = 'DROP EVENT TRIGGER' then return; end if;",
    "  if tg_tag not like 'DROP %' then return; end if;",
    "  if current_setting('okm.allow_drop', true) = 'true' then return; end if;",
    "  raise exception 'okm_guard_drops refuses %', tg_tag using errcode = 'P0001';",
    "end",
  ].join("\n");
}

function rewriteBody(): string {
  return [
    "begin",
    "  if current_setting('okm.allow_rewrite', true) = 'true' then return; end if;",
    "  raise exception 'okm_guard_rewrites refuses a table rewrite' using errcode = 'P0001';",
    "end",
  ].join("\n");
}

function enableBody(schemas: readonly string[]): string {
  const list = schemas.map((item) => quoteLiteral(item)).join(", ");
  return [
    "declare cmd record;",
    "begin",
    "  for cmd in select * from pg_event_trigger_ddl_commands() loop",
    "    if cmd.in_extension then continue; end if;",
    "    if cmd.schema_name is null or cmd.schema_name like 'pg_temp%' then continue; end if;",
    "    if cmd.command_tag not in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') then continue; end if;",
    `    if cmd.schema_name not in (${list}) then continue; end if;`,
    "    execute format('alter table %s enable row level security', cmd.object_identity);",
    "  end loop;",
    "end",
  ].join("\n");
}

function auditFunction(schemaName: string, body: string): FunctionObject {
  return functionObject({
    namespace: staticNamespace(schemaName),
    name: "okm_audit_ddl",
    arguments: [],
    returns: "event_trigger",
    language: "plpgsql",
    volatility: "volatile",
    security: "definer",
    searchPath: `${schemaName}, pg_temp`,
    ownedBy: "okm_role:migration",
    body,
    provenance: PROVENANCE("auditDdl"),
    dependencies: [],
  });
}

function auditBody(
  schemaName: string,
  tx: string,
  cmd: string,
  transactions: AnyTable,
  commands: AnyTable,
  col: (item: AnyTable, field: string) => string,
): string {
  const txid = col(transactions, "txid");
  const at = col(transactions, "at");
  const session = col(transactions, "actor");
  const app = col(transactions, "app_name");
  const addr = col(transactions, "client_addr");
  const query = col(transactions, "query_text");
  const appUser = col(transactions, "app_user");
  const commandTag = col(commands, "command_tag");
  const objectType = col(commands, "object_type");
  const objectIdentity = col(commands, "object_identity");
  const schemaCol = col(commands, "schema_name");
  const cascade = col(commands, "cascade");
  const cmdTx = col(commands, "txid");
  const qualifiedTx = `${quoteIdent(schemaName)}.${quoteIdent(tx)}`;
  const qualifiedCmd = `${quoteIdent(schemaName)}.${quoteIdent(cmd)}`;
  return [
    "declare cmd record; obj record;",
    "begin",
    `  insert into ${qualifiedTx} (${txid}, ${at}, ${session}, ${app}, ${addr}, ${query}, ${appUser})`,
    "  values (txid_current()::text, now(), session_user, current_setting('application_name', true), inet_client_addr(), current_query(), nullif(current_setting('okm.application_user', true), ''))",
    `  on conflict (${txid}) do nothing;`,
    "  if tg_event = 'sql_drop' then",
    "    for obj in select * from pg_event_trigger_dropped_objects() loop",
    "      if obj.is_temporary then continue; end if;",
    `      insert into ${qualifiedCmd} (${cmdTx}, ${commandTag}, ${objectType}, ${objectIdentity}, ${schemaCol}, ${cascade})`,
    "      values (txid_current()::text, tg_tag, obj.object_type, obj.object_identity, obj.schema_name, not obj.original);",
    "    end loop;",
    "    return;",
    "  end if;",
    "  for cmd in select * from pg_event_trigger_ddl_commands() loop",
    "    if cmd.in_extension then continue; end if;",
    "    if cmd.schema_name like 'pg_temp%' then continue; end if;",
    `    insert into ${qualifiedCmd} (${cmdTx}, ${commandTag}, ${objectType}, ${objectIdentity}, ${schemaCol}, ${cascade})`,
    "    values (txid_current()::text, cmd.command_tag, cmd.object_type, cmd.object_identity, cmd.schema_name, false);",
    "  end loop;",
    "end",
  ].join("\n");
}

function pin(built: CatalogObject[], tableName: string, schemaName: string): void {
  const namespace = staticNamespace(schemaName);
  const provenance: Provenance = { origin: "trait", name: "auditDdl" };
  const move = (target: ObjectIdentity): ObjectIdentity => {
    if (
      (target.kind === "table" && target.name === tableName) ||
      (target.kind === "sequence" && target.name.startsWith(`${tableName}_`))
    ) {
      return { ...target, namespace };
    }
    if ("parent" in target && target.parent.name === tableName) {
      return { ...target, parent: { ...target.parent, namespace } };
    }
    return target;
  };
  let found = false;
  for (let index = 0; index < built.length; index += 1) {
    const object = built[index];
    if (object === undefined) continue;
    const dependencies = object.dependencies.map((edge) => ({
      ...edge,
      target: move(edge.target),
    }));
    const owned =
      (object.kind === "table" && object.identity.name === tableName) ||
      (object.kind === "sequence" && object.identity.name.startsWith(`${tableName}_`)) ||
      ("parent" in object.identity && object.identity.parent.name === tableName);
    if (!owned) {
      if (dependencies.some((edge, at) => edge.target !== object.dependencies[at]?.target)) {
        built[index] = { ...object, dependencies };
      }
      continue;
    }
    if (object.kind === "table") found = true;
    if ("parent" in object.identity) {
      built[index] = {
        ...object,
        identity: {
          ...object.identity,
          parent: { ...object.identity.parent, namespace },
        },
        provenance,
        dependencies,
      } as CatalogObject;
      continue;
    }
    if (object.kind === "table") {
      built[index] = {
        ...object,
        identity: { ...object.identity, namespace },
        provenance,
        dependencies,
      };
      continue;
    }
    if (object.kind === "sequence") {
      built[index] = {
        ...object,
        identity: { ...object.identity, namespace },
        provenance,
        dependencies,
      };
    }
  }
  if (!found) {
    throw new OkmError(
      "OKM1931",
      `auditDdl table ${tableName} is not in the schema. Pass the tables auditDdl() returns in schema({ tables }).`,
      { fix: { summary: "Add audit.transactions and audit.commands to schema({ tables })." } },
    );
  }
}
