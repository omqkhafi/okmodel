# Driver compatibility

Generated from the conformance run (`tests/driver-suite.test.ts` and `tests/error-suite.test.ts`). Do not edit by hand.

Supported majors are Postgres 15, 16, 17, and 18. The floor is 15: Postgres 13 is past end of life, 14 ends in November 2026, and 15 gives us features we can use later. `connect()` refuses an older server with OKM1803 unless `schema({ requires })` names that major. Identity columns need Postgres 10. `gen_random_uuid()` is built in from Postgres 13. `uuidv7()` needs Postgres 18. A pull request runs real Postgres only with the label `needs: postgres`: the suite on 15 and 18 and the tarball job on 18. `bun run verify` runs the suite on this machine. The release and the weekly run cover each supported major. A failure on an older major in this list stays in the run.

PGlite runs in the check job. The in-process wire server runs in the check job. postgres.js, node-postgres, and Bun.sql run in the postgres job (`REQUIRE_DOCKER=1`). Bun.sql runs only under Bun. A skip means the adapter did not declare the capability that case needs. node-postgres and Bun.sql do not describe a statement without running it. Bun.sql does not surface RAISE NOTICE and does not abort an in-flight statement.

| Case | postgres.js | node-postgres | Bun.sql | PGlite |
| --- | --- | --- | --- | --- |
| execute returns rows | pass | pass | pass | pass |
| keeps null as null | pass | pass | pass | pass |
| keeps timestamps as wire text | pass | pass | pass | pass |
| keeps numeric as wire text | pass | pass | pass | pass |
| keeps bigint as wire text | pass | pass | pass | pass |
| keeps json as wire text | pass | pass | pass | pass |
| keeps arrays as wire text | pass | pass | pass | pass |
| returns notices | pass | pass | skip | pass |
| batch commits every statement | pass | pass | pass | pass |
| batch rolls back a failure at each position | pass | pass | pass | pass |
| batch reports a deferred constraint at commit | pass | pass | pass | pass |
| rejects a pre-aborted signal before the statement | pass | pass | pass | pass |
| cancels an in-flight statement | pass | pass | skip | skip |
| times out an in-flight statement | pass | pass | skip | skip |
| cancels a batch and rolls it back | pass | pass | skip | skip |
| times out a batch and rolls it back | pass | pass | skip | skip |
| runs a batch inside a transaction on a savepoint | pass | pass | pass | pass |
| clears a custom setting and an advisory lock on release | pass | pass | pass | pass |
| reports pool stats | pass | pass | pass | pass |
| close rejects a later execute | pass | pass | pass | pass |
| acquire timeout is OKM1846 and does not use another pool | pass | pass | pass | pass |
| describes a statement | pass | skip | skip | pass |
| streams rows | pass | pass | pass | skip |
| delivers a notification | pass | pass | pass | pass |
| maps a unique violation | pass | pass | pass | pass |
| maps a not-null violation | pass | pass | pass | pass |
| maps a check violation | pass | pass | pass | pass |
| maps a foreign key violation | pass | pass | pass | pass |
| maps an exclusion violation | pass | pass | pass | pass |
| maps serialization, deadlock, and lock timeout | pass | pass | pass | pass |
| maps a statement timeout | pass | pass | pass | pass |
| maps an in-flight statement timeout | pass | pass | skip | skip |
| maps a cancelled call and does not retry it | pass | pass | pass | pass |
| maps a connection failure | pass | pass | pass | pass |
| carries batchIndex on a batch failure and null at commit | pass | pass | pass | pass |
