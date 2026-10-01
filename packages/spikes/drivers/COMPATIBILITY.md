# Driver compatibility

Generated from conformance results. Do not edit by hand.

| Driver      | Server                          |
| ----------- | ------------------------------- |
| postgres.js | 17.11 (Debian 17.11-1.pgdg13+2) |
| PGlite      | 18.3                            |
| batch-mode  | 17.11 (Debian 17.11-1.pgdg13+2) |

| Test                     | postgres.js                              | PGlite                                                                   | batch-mode                                     |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| execute.rows             | pass                                     | pass                                                                     | pass                                           |
| execute.params           | pass                                     | pass                                                                     | pass                                           |
| execute.codecs           | pass                                     | pass                                                                     | pass                                           |
| execute.notices          | pass                                     | pass                                                                     | pass                                           |
| execute.errors           | pass                                     | pass                                                                     | pass                                           |
| signal.preaborted        | pass                                     | pass                                                                     | pass                                           |
| execute.cancel           | pass                                     | skip: cancel is not declared                                             | pass                                           |
| timeout.declaration      | pass                                     | pass                                                                     | pass                                           |
| transactions.interactive | pass                                     | pass                                                                     | skip: transactions interactive is not declared |
| transactions.batch       | skip: transactions batch is not declared | skip: transactions batch is not declared                                 | pass                                           |
| stream.cursor            | pass                                     | skip: stream is not declared                                             | skip: stream is not declared                   |
| listen.notify            | pass                                     | pass                                                                     | skip: listen is not declared                   |
| describe.query           | pass                                     | pass                                                                     | skip: describe is not declared                 |
| prepared.named           | pass                                     | skip: prepared named is not declared                                     | skip: prepared named is not declared           |
| prepared.unnamed         | pass                                     | pass                                                                     | skip: prepared unnamed is not declared         |
| prepared.none            | pass                                     | pass                                                                     | pass                                           |
| stats.shape              | pass                                     | pass                                                                     | pass                                           |
| batch.atomic.success     | pass                                     | pass                                                                     | pass                                           |
| batch.atomic.failure     | pass                                     | pass                                                                     | pass                                           |
| batch.atomic.deferred    | pass                                     | pass                                                                     | pass                                           |
| batch.atomic.sequences   | pass                                     | pass                                                                     | pass                                           |
| batch.atomic.cancel      | pass                                     | skip: cancel is not declared                                             | pass                                           |
| batch.atomic.timeout     | pass                                     | skip: cancel is not declared, so an in-flight timeout cannot be enforced | pass                                           |
| batch.atomic.savepoint   | pass                                     | pass                                                                     | skip: transactions interactive is not declared |
| batch.atomic.outcome     | pass                                     | skip: no separate backend to terminate                                   | pass                                           |
