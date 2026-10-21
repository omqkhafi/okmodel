---
okmVersion: "0.10.0"
since: "0.10"
dialects: [postgres]
codes: [OKM1510, OKM1850, OKM1853]
---

# Threat model for agent use

This page is what OKModel defends against when an agent reads errors, plans a migration, or runs a command. Each claim names the feature or the test that backs it. A claim without that backing is not here.

Read [untrusted text](untrusted.md), [protected targets](protection.md), and [production](production.md) with this page.

## Prompt injection through error text and database values

Text from a database error, a catalog, or a user query is an object with `untrusted: true`, an origin, and a bounded `text`. The human line is `untrusted <origin>: "<text>"`. It is not an instruction. The cap is 200 code points for one string and 2,000 for one field. A caller may lower a cap and may not raise one. Bidi overrides and tag characters are removed from that text.

Feature: `untrustedText` in `src/tooling/untrusted.ts`. Contract: [untrusted text](untrusted.md). Tests: `tests/untrusted.test.ts` (Arabic, Persian, Hebrew, and Indic text stays; bidi overrides and tag characters are removed; stderr keeps `ignore previous instructions` inside the untrusted line).

## Destructive migrations

Dropping a table, renaming a column, or adding a unique constraint on a table that already exists is an error finding, OKM1510. `okm generate` still writes the file and exits 1. `okm migrate plan` and `okm check` exit non-zero. `okm migrate apply` refuses with OKM1510 before any statement. A plan whose operation class is `destructive` sets `requiresAck`. Apply does not ask, and it does not read that flag. The only way past a destructive step is a `-- okm-allow CODE: reason` line in the committed migration file. No command-line flag does it. `okm check` and `okm migrate check` list those lines, and a boilerplate reason is warning OKM2300. A person reviews the line in the pull request, and a protected target still needs a terminal.

Feature: the migration linter and `operationClass`. Tests: `tests/lint.test.ts` (OKM1510 on the plan, on check, and on generate) and `tests/canonical-json.test.ts` (`operationClass` is `destructive`).

## Wrong-target runs

A target is protected when project config sets `protected: true` or when `okm protect add` has stored its fingerprint. The fingerprint is `hostDb`, the SHA-256 of lower-cased `host:port/database`. The user, the password, and the query string are not part of it. A state-changing command against a protected target exits 4. `okm migrate check` refuses a protected target, and `--allow-protected` does not lift that refusal. Omitting `--target` when several targets are configured is OKM1853 for commands that must pick one database.

Feature: protected targets and the fingerprint store. Contract: [protected targets](protection.md) and [production](production.md). Tests: `tests/protection.test.ts` (the stored value is `hostDb`, not a URL).

## Credential leakage

The protection store holds hashes, not URLs. Command output does not print the URL. `okm protect list` prints fingerprints. JSON for that command has `identity` null and does not include the URL.

Feature: `hostDbFingerprint` in `src/tooling/migrate/fingerprint.ts`. Contract: [protected targets](protection.md). Test: `tests/protection.test.ts`.

## Hidden Unicode in docs

The packed text files are scanned for NUL, zero-width characters, bidi overrides and isolates, tag characters, and variation selectors outside an emoji sequence. Arabic, Persian, Hebrew, and Indic letters are allowed. ZWNJ and ZWJ are allowed only inside a word in a file named by `HIDDEN_CHAR_ALLOWLIST` in `scripts/docs-hygiene.ts`. That list is empty. The same classes of bidi override and tag character are stripped from untrusted database and error text.

Feature: `hiddenCharsIn` in `scripts/docs-hygiene.ts`, and `untrustedText` for values that came from the database. Tests: `tests/docs-hygiene.test.ts` and `tests/untrusted.test.ts`.

## What this does not defend against

- A program running as the same operating-system user can edit the protection file, delete it, or set `protected: false`. The page that states this is [protected targets](protection.md). The grant in [roles](roles.md) is the boundary that still holds.
- `default_transaction_read_only` is a session setting. A session can turn it off. [roles](roles.md) uses `GRANT`, not that setting.
- Marking text untrusted reduces the chance an agent obeys it. It does not eliminate that chance. The sentence is in [untrusted text](untrusted.md).
- OKM1538, a type change that rewrites the heap, is a warning. Apply does not refuse it. The recipe is [a type change](type-change.md). There is no separate command for it.
- A login that is a superuser, or that holds `CREATEROLE` and ownership, can do more than the reader role in [roles](roles.md).
- The doc scan does not read rows in the database. Values that pass through `untrustedText` are the ones that are bounded and stripped.
