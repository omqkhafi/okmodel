---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: []
---
# Untrusted text

Text read from a database catalog, a database error, or a user query is bounded and marked untrusted; this reduces risk and does not eliminate it.

Each value is an object. The keys are `untrusted`, `origin`, `text`, `truncated`, and `modified`. One string keeps at most 200 code points. One response field keeps at most 2,000. A caller may set a lower cap. A caller may not raise one.

The human line is `untrusted <origin>: "<text>"`. That line stands on its own. It is not an instruction.

`okm migrate plan --json` adds `operationClass` on the plan and on each step, `fromCatalogHash`, `toCatalogHash`, `planHash`, `requiresAck`, and `destructiveOperations`. `planHash` is the SHA-256 of canonical JSON for format 1, the dialect, the two catalog hashes, and each step's SQL as executed with its operation class. The hash omits the target, timestamps, and the OKModel version. `requiresAck` is true when the plan's operation class is `destructive`. The plan command does not ask, and apply is unchanged.

A finding `reason` is an untrusted object with origin `user.query`. `fix` stays a string written by OKModel. A database error's text is `errors[].detail`, and the summary stays the registry sentence. `okm migrate status` JSON stores `steps[].id`, `kind`, and `state` as untrusted objects. The text table is unchanged. `okm migrate baseline --json` stores each unmanaged `name` as an untrusted object.
