# Driver compatibility

Generated from the conformance run (`tests/driver-suite.test.ts` and `tests/error-suite.test.ts`). Do not edit by hand.

Supported majors are Postgres 13, 14, 15, 16, 17, and 18. Identity columns need Postgres 10. `gen_random_uuid()` is built in from Postgres 13, and that version is the floor because the portable UUID default uses it. `uuidv7()` needs Postgres 18. The postgres job runs the suite on each of these majors. A failure on an older major in this list stays in the run.

PGlite runs in the check job. The in-process wire server runs in the check job. postgres.js runs in the postgres job (`REQUIRE_DOCKER=1`). A skip means the adapter did not declare the capability that case needs.

| Case | postgres.js | PGlite |
| --- | --- | --- |
| execute returns rows | pass | pass |
| keeps null as null | pass | pass |
| keeps timestamps as wire text | pass | pass |
| keeps numeric as wire text | pass | pass |
| keeps bigint as wire text | pass | pass |
| keeps json as wire text | pass | pass |
| keeps arrays as wire text | pass | pass |
| returns notices | pass | pass |
| batch commits every statement | pass | pass |
| batch rolls back a failure at each position | pass | pass |
| batch reports a deferred constraint at commit | pass | pass |
| rejects a pre-aborted signal before the statement | pass | pass |
| cancels an in-flight statement | pass | skip |
| times out an in-flight statement | pass | skip |
| cancels a batch and rolls it back | pass | skip |
| times out a batch and rolls it back | pass | skip |
| runs a batch inside a transaction on a savepoint | pass | pass |
| clears a custom setting and an advisory lock on release | pass | pass |
| reports pool stats | pass | pass |
| close rejects a later execute | pass | pass |
| acquire timeout is OKM1846 and does not use another pool | pass | pass |
| describes a statement | pass | pass |
| streams rows | pass | skip |
| delivers a notification | pass | pass |
| maps a unique violation | pass | pass |
| maps a not-null violation | pass | pass |
| maps a check violation | pass | pass |
| maps a foreign key violation | pass | pass |
| maps an exclusion violation | pass | pass |
| maps serialization, deadlock, and lock timeout | pass | pass |
| maps a statement timeout | pass | pass |
| maps an in-flight statement timeout | pass | skip |
| maps a cancelled call and does not retry it | pass | pass |
| maps a connection failure | pass | pass |
| carries batchIndex on a batch failure and null at commit | pass | pass |
