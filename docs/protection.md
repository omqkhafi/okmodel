---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: []
---
# Protected targets

Protection is the union of two records. Either one is enough.

- Project config sets `protected: true` on a target. `--allow-protected` is that invocation only. It does not change the config, and nothing reads it from the environment.
- The user store is `$XDG_CONFIG_HOME/okm/protected.json`, or `~/.config/okm/protected.json` when `XDG_CONFIG_HOME` is unset. On Windows the file is `%APPDATA%\okm\protected.json`. There is no environment variable that moves this file.

`okm protect add` records the selected target. `okm protect list` prints the stored fingerprints. `okm protect remove` deletes the selected target's fingerprint and requires a terminal; without one it exits 4. Removing `protected: true` from the project config does not delete a stored fingerprint.

The fingerprint is `hostDb`, the SHA-256 of lower-cased `host:port/database`. The user, the password, and the query string are not part of it. `identity` is null. This build does not read `pg_control_system()`. The store holds those hashes, not URLs. Command output does not print the URL.

A state-changing command against a stored fingerprint exits 4 when the process has no terminal, including when the invocation passed `--allow-protected`. Project-config protection is unchanged: `--allow-protected` still lifts contract, push, seed, backfill, and history repair for that invocation. `okm migrate check` still refuses a protected target, and the flag does not lift it. `drop` and `rollback` are not commands. They stay policy refusals: there is no down migration.

The refusal names the match: `project config`, `store fingerprint`, or `project config and store fingerprint`.

A terminal is friction, not proof of a human. A program that can open a terminal, or that runs as the same OS user, can write the store, delete the file, or set `protected: false` in the project. No local scheme is unforgeable against an agent running as that user. The structural refusal stops accidents and naive injection. A database role that cannot run the statement stops a determined same-user agent. `connect()` does not read protection.
