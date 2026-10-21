---
okmVersion: "0.10.0"
since: "0.10"
dialects: [postgres]
codes: [OKM1707, OKM1825, OKM1850]
---

# Least-privilege roles for an agent

An agent that can log in should not use the role that owns the schema. Privileges are grants. A session flag is not a privilege: the session can change it.

PostgreSQL 15, 16, 17, and 18 all provide `pg_read_all_data`. Use it for read-only inspection. Give `okm migrate apply` a different role that has `CREATE` on the schema. Do not set `default_transaction_read_only`. A session can run `SET default_transaction_read_only = off` and the grant is unchanged.

## Read-only inspection

`okm_agent_reader` can `SELECT` every table. It cannot create objects. Point the agent's login at a role that is a member of this one, and at nothing else.

```sql
CREATE ROLE okm_agent_reader NOLOGIN;
GRANT pg_read_all_data TO okm_agent_reader;
```

## Migrator

`okm_agent_migrator` is the role for `okm migrate apply`. `CREATE` on the schema lets it create objects there. It is not the reader. A human runs apply with a login that is a member of this role. The agent login is not.

```sql
CREATE ROLE okm_agent_migrator NOLOGIN;
GRANT CREATE ON SCHEMA public TO okm_agent_migrator;
GRANT pg_read_all_data TO okm_agent_migrator;
```

Replace `public` with the schema `defineConfig` uses. The migrator must own that schema before it grants to other roles, or apply fails with OKM1825. When the plan also creates an application role, a superuser or a role with `CREATEROLE` still has to establish membership. An application login that is a superuser, the owner, or `BYPASSRLS` is OKM1707 under row-level security.

## How protection fits

Grants are the boundary a determined agent cannot step over without a richer role. `okm protect add` records a fingerprint of the target. `okm protect list` prints those fingerprints and does not print the URL. `okm protect remove` deletes one fingerprint and requires a terminal. A state-changing command against a protected target is refused (OKM1850) unless that invocation passes `--allow-protected`. `okm migrate check` stays refused on a protected target. A destructive migration step is separate: it runs only when its committed file carries a `-- okm-allow` line, which `okm check` lists.

A role that lacks `CREATE` still cannot apply DDL when someone passes `--allow-protected`. Protection stops the accident. The grant stops the statement. The two are complements, and neither one is a session flag.
