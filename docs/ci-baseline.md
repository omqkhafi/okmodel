# CI baseline

Before number for the CI diet (issue #359). Produced by `bun run ci:report` at 2026-10-18T10:59:59.142Z from `omqkhafi/okmodel`. Do not edit the tables by hand; run the command again.

## Method

`ci:report` shells out to `gh api` for the repository `gh repo view` names.

- **Main sample.** `GET /repos/{owner}/{repo}/actions/runs?branch=main&status=completed&per_page=30`, the thirty newest completed runs on `main`, every workflow.
- **Jobs and steps.** `GET /repos/{owner}/{repo}/actions/runs/{id}/jobs?per_page=100` for each of those runs. Duration is `completed_at` minus `started_at`, in whole seconds. A skipped job, or a step with no timestamps, is left out of the duration tables.
- **Queue.** `run_started_at` minus `created_at` for the workflow run. That is time spent before a runner accepted the run.
- **Gate wall.** For a CI run, `gate / check`'s `completed_at` minus `created_at`. That is how long the required status takes. **Run wall** is `updated_at` minus `created_at`, which stays open while jobs the gate does not need are still running.
- **Critical path.** The long pole is the job the gate waited on: among jobs other than `gate / check`, `label / paths`, `lint / pull request`, and `attest / measure`, the one with the latest `completed_at` at or before the gate started. The path is that job, then the gate. A workflow with no gate uses the job that finished last, and its gate wall is the run wall.
- **Re-runs.** A run with `run_attempt` greater than 1. Extra attempts are `run_attempt` minus 1.
- **Train pulls.** For each of #346 through #356, the pull, its commits (`per_page=100`), then `GET /repos/{owner}/{repo}/actions/runs?head_sha={sha}&per_page=50` for each commit. Only `pull_request` runs are kept. A commit that was never a head SHA has no run and is not a push.
- **Why.** A push-and-fail round is a push whose latest attempt failed a job `gate / check` waits on. `lint / pull request` and `label / paths` do not count: the required status does not wait on them, so a red pull-request lint alone is not a round. `gate / check` itself is ignored when another job failed, because it only repeats that failure. A named step wins. Format or Lint is format/lint. Typecheck, Editor, or Type cost is types. Docs or Readme is docs. Size is the size gate. Test, or a `test / …` job with no failed step, is unit. A job named `suite` or `tarball` (including `suite / 18 / consistency`), or a Postgres suite or Tarball quickstart step, is Postgres. Setup steps and anything else are other, and the step name is kept in the table. A `lint / static` failure on Layers, or a `types / compiler` failure on Install, stays other.
- **Median.** The middle value. An even count rounds the mean of the two middle values to the nearest second (half rounds away from zero). **p90** is the nearest-rank percentile.

## Main sample

30 completed runs on `main`, newest first. 9 of them are the CI workflow.

| Workflow | Runs | Median run wall | Median queue | Re-runs |
| --- | ---: | ---: | ---: | ---: |
| CI | 9 | 195s | 0s | 0 |
| Deploy site | 3 | 1s | 0s | 0 |
| Site | 9 | 44s | 0s | 0 |
| Windows | 9 | 190s | 0s | 0 |

| Run | Workflow | Queue | Gate wall | Run wall | Long pole | Attempt |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| [39119208262](https://github.com/omqkhafi/okmodel/actions/runs/39119208262) | Site | 0s | 37s | 37s | tests (34s) | 1 |
| [39119208344](https://github.com/omqkhafi/okmodel/actions/runs/39119208344) | Windows | 0s | 190s | 190s | audit / checklist (172s) | 1 |
| [39119208437](https://github.com/omqkhafi/okmodel/actions/runs/39119208437) | CI | 0s | 188s | 189s | test / topology (175s) | 1 |
| [39055660245](https://github.com/omqkhafi/okmodel/actions/runs/39055660245) | Site | 0s | 43s | 43s | build (38s) | 1 |
| [39055660346](https://github.com/omqkhafi/okmodel/actions/runs/39055660346) | CI | 0s | 174s | 174s | test / topology (149s) | 1 |
| [39055660260](https://github.com/omqkhafi/okmodel/actions/runs/39055660260) | Windows | 0s | 186s | 186s | audit / checklist (168s) | 1 |
| [39055592829](https://github.com/omqkhafi/okmodel/actions/runs/39055592829) | Deploy site | 0s | 72s | 72s | deploy / production (68s) | 1 |
| [39054292970](https://github.com/omqkhafi/okmodel/actions/runs/39054292970) | Deploy site | 0s | — | 1s | — | 1 |
| [39047468153](https://github.com/omqkhafi/okmodel/actions/runs/39047468153) | Deploy site | 0s | — | 1s | — | 1 |
| [39046552759](https://github.com/omqkhafi/okmodel/actions/runs/39046552759) | Site | 0s | 50s | 50s | tests (34s) | 1 |
| [39046552810](https://github.com/omqkhafi/okmodel/actions/runs/39046552810) | CI | 0s | 188s | 189s | test / drivers (172s) | 1 |
| [39046552695](https://github.com/omqkhafi/okmodel/actions/runs/39046552695) | Windows | 0s | 176s | 176s | audit / checklist (156s) | 1 |
| [39039772594](https://github.com/omqkhafi/okmodel/actions/runs/39039772594) | Site | 0s | 40s | 40s | tests (35s) | 1 |
| [39039772581](https://github.com/omqkhafi/okmodel/actions/runs/39039772581) | Windows | 0s | 164s | 164s | audit / checklist (142s) | 1 |
| [39039772655](https://github.com/omqkhafi/okmodel/actions/runs/39039772655) | CI | 0s | 194s | 195s | test / drivers (180s) | 1 |
| [39039308620](https://github.com/omqkhafi/okmodel/actions/runs/39039308620) | CI | 0s | 189s | 189s | test / drivers (172s) | 1 |
| [39039308566](https://github.com/omqkhafi/okmodel/actions/runs/39039308566) | Windows | 0s | 193s | 193s | audit / checklist (164s) | 1 |
| [39039308590](https://github.com/omqkhafi/okmodel/actions/runs/39039308590) | Site | 0s | 42s | 42s | build (38s) | 1 |
| [39036646889](https://github.com/omqkhafi/okmodel/actions/runs/39036646889) | Site | 0s | 44s | 44s | build (40s) | 1 |
| [39036646939](https://github.com/omqkhafi/okmodel/actions/runs/39036646939) | Windows | 0s | 168s | 168s | audit / checklist (146s) | 1 |
| [39036646948](https://github.com/omqkhafi/okmodel/actions/runs/39036646948) | CI | 0s | 198s | 198s | test / topology (172s) | 1 |
| [39034127241](https://github.com/omqkhafi/okmodel/actions/runs/39034127241) | Site | 0s | 52s | 52s | build (47s) | 1 |
| [39034127220](https://github.com/omqkhafi/okmodel/actions/runs/39034127220) | Windows | 0s | 190s | 190s | audit / checklist (170s) | 1 |
| [39034127291](https://github.com/omqkhafi/okmodel/actions/runs/39034127291) | CI | 0s | 195s | 196s | test / drivers (170s) | 1 |
| [39027680166](https://github.com/omqkhafi/okmodel/actions/runs/39027680166) | Site | 0s | 50s | 50s | build (33s) | 1 |
| [39027680261](https://github.com/omqkhafi/okmodel/actions/runs/39027680261) | Windows | 0s | 199s | 199s | audit / checklist (166s) | 1 |
| [39027680248](https://github.com/omqkhafi/okmodel/actions/runs/39027680248) | CI | 0s | 202s | 203s | test / topology (176s) | 1 |
| [39026555226](https://github.com/omqkhafi/okmodel/actions/runs/39026555226) | Site | 0s | 80s | 80s | build (38s) | 1 |
| [39026555292](https://github.com/omqkhafi/okmodel/actions/runs/39026555292) | Windows | 0s | 195s | 195s | audit / checklist (165s) | 1 |
| [39026555238](https://github.com/omqkhafi/okmodel/actions/runs/39026555238) | CI | 0s | 268s | 269s | test / drivers (175s) | 1 |

## Critical path

CI runs in the sample: 9.

| | Median | p90 | Min | Max |
| --- | ---: | ---: | ---: | ---: |
| Gate wall | 194s | 268s | 174s | 268s |
| Queue | 0s | 0s | 0s | 0s |

Long pole, by how often it was the job the gate waited on: test / drivers (5), test / topology (4).

## Re-runs

None of the 30 runs was a re-run (`run_attempt` is 1 on each).

## CI jobs

| Job | N | Median | p90 | Max |
| --- | ---: | ---: | ---: | ---: |
| test / drivers | 9 | 172s | 180s | 180s |
| test / topology | 9 | 170s | 176s | 176s |
| test / safety | 9 | 71s | 77s | 77s |
| test / client | 9 | 58s | 70s | 70s |
| test / package | 9 | 51s | 54s | 54s |
| test / schema | 9 | 20s | 24s | 24s |
| test / migrate | 9 | 19s | 21s | 21s |
| package / checks | 9 | 17s | 19s | 19s |
| types / compiler | 9 | 17s | 25s | 25s |
| temporal / node 26 | 9 | 13s | 28s | 28s |
| test / columns | 9 | 13s | 22s | 22s |
| test / contracts | 9 | 13s | 15s | 15s |
| test / rows | 9 | 13s | 17s | 17s |
| attest / measure | 9 | 12s | 15s | 15s |
| lint / static | 9 | 12s | 15s | 15s |
| runtimes / portable | 9 | 12s | 18s | 18s |
| test / client pg | 9 | 11s | 14s | 14s |
| test / migrate pg | 9 | 11s | 12s | 12s |
| temporal / node 24 | 9 | 10s | 13s | 13s |
| test / schema pg | 9 | 10s | 12s | 12s |
| test / scripts | 9 | 10s | 14s | 14s |
| test / tenancy | 9 | 10s | 13s | 13s |
| test / reference app | 9 | 9s | 20s | 20s |
| temporal / node 22 | 9 | 8s | 21s | 21s |
| gate / check | 9 | 7s | 10s | 10s |

## CI steps

| Step | N | Median | p90 | Max |
| --- | ---: | ---: | ---: | ---: |
| test / drivers / Test | 9 | 163s | 170s | 170s |
| test / topology / Test | 9 | 162s | 167s | 167s |
| test / safety / Test | 9 | 64s | 68s | 68s |
| test / client / Test | 9 | 49s | 60s | 60s |
| test / package / Test | 9 | 43s | 46s | 46s |
| test / migrate / Test | 9 | 10s | 12s | 12s |
| test / schema / Test | 9 | 10s | 14s | 14s |
| package / checks / Size | 9 | 6s | 7s | 7s |
| types / compiler / Type cost | 9 | 6s | 7s | 7s |
| temporal / node 26 / Setup Node | 9 | 5s | 16s | 16s |
| test / rows / Test | 9 | 5s | 6s | 6s |
| attest / measure / Attest | 9 | 4s | 6s | 6s |
| test / columns / Test | 9 | 3s | 9s | 9s |
| test / contracts / Test | 9 | 3s | 5s | 5s |
| types / compiler / Typecheck | 9 | 3s | 5s | 5s |
| attest / measure / Setup Bun | 9 | 2s | 2s | 2s |
| gate / check / Setup Bun | 9 | 2s | 2s | 2s |
| lint / static / Checkout | 9 | 2s | 2s | 2s |
| lint / static / Lint | 9 | 2s | 3s | 3s |
| package / checks / Are the types wrong | 9 | 2s | 3s | 3s |
| package / checks / Setup Bun | 9 | 2s | 2s | 2s |
| runtimes / portable / Setup Deno | 8 | 2s | 2s | 2s |
| temporal / node 24 / Set up job | 9 | 2s | 2s | 2s |
| temporal / node 26 / Set up job | 9 | 2s | 2s | 2s |
| test / columns / Build | 9 | 2s | 4s | 4s |
| test / columns / Checkout | 9 | 2s | 2s | 2s |
| test / columns / Setup Bun | 9 | 2s | 3s | 3s |
| test / contracts / Build | 9 | 2s | 5s | 5s |
| test / migrate pg / Build | 9 | 2s | 4s | 4s |
| test / migrate pg / Setup Bun | 9 | 2s | 2s | 2s |
| test / migrate pg / Test | 9 | 2s | 4s | 4s |
| test / safety / Build | 9 | 2s | 4s | 4s |
| test / schema / Setup Bun | 9 | 2s | 2s | 2s |
| test / schema pg / Setup Bun | 9 | 2s | 3s | 3s |
| test / scripts / Setup Bun | 9 | 2s | 2s | 2s |
| test / tenancy / Test | 9 | 2s | 4s | 4s |
| test / topology / Checkout | 9 | 2s | 2s | 2s |
| types / compiler / Editor | 9 | 2s | 4s | 4s |

202 steps had a median under 2s and are omitted (checkout, setup, and the other short steps). 240 steps were measured.

## 0.9.1 train

Pulls #346 through #356. A push is a commit SHA that received a workflow run. A fail round is a push whose latest attempt failed a job the required status waits on. A red pull-request lint alone is not a round.

| Pull | Pushes | Fail rounds | Re-runs | Why |
| --- | ---: | ---: | ---: | --- |
| [#346 fix(bun-sql): isolate sessions and report committed writes (B-03, B-04)](https://github.com/omqkhafi/okmodel/pull/346) | 3 | 2 | 0 | `d62179b` postgres; `c5b3889` format/lint, size |
| [#347 fix(migrate): push re-applies, hash re-stamps, check handles triggers (B-29, B-21, B-24)](https://github.com/omqkhafi/okmodel/pull/347) | 1 | 0 | 0 | — |
| [#348 fix(pull): generated code builds and names stay stable (B-14 to B-19, B-38)](https://github.com/omqkhafi/okmodel/pull/348) | 2 | 1 | 0 | `d809ec1` postgres |
| [#349 fix(runtime): refuse unknown write keys, redact sensitive causes (B-39, B-33)](https://github.com/omqkhafi/okmodel/pull/349) | 1 | 0 | 0 | — |
| [#350 fix(runtime): explicit 65535 parameter limit (B-40)](https://github.com/omqkhafi/okmodel/pull/350) | 2 | 1 | 0 | `bddaa8d` postgres |
| [#351 fix(roles-cli): roles apply, functions not PUBLIC, pooler URLs (B-30, B-31, B-25, B-41)](https://github.com/omqkhafi/okmodel/pull/351) | 5 | 4 | 0 | `422ac8d` unit, postgres; `bc7ef38` postgres; `5218971` postgres; `d3e6fa1` format/lint |
| [#352 fix(adapters): bounded storm recovery and idle-client errors (B-02, B-43, B-44)](https://github.com/omqkhafi/okmodel/pull/352) | 2 | 1 | 0 | `15cf224` postgres |
| [#353 docs(known-limits): honesty pass and last coverage gaps (DM-1 to DM-12, B-07, B-08)](https://github.com/omqkhafi/okmodel/pull/353) | 1 | 0 | 0 | — |
| [#354 fix(runtime): tree cycles, Action author check, driver test, testing helpers (B-10, B-22, B-05, B-06, B-42, B-35, B-32, B-28, B-34)](https://github.com/omqkhafi/okmodel/pull/354) | 1 | 0 | 0 | — |
| [#355 chore(release): 0.9.1](https://github.com/omqkhafi/okmodel/pull/355) | 6 | 3 | 0 | `2a5eb5f` other (Tests); `1af97f7` postgres; `187eff6` format/lint |
| [#356 fix(adapters): free node-postgres slots after a timed kill storm](https://github.com/omqkhafi/okmodel/pull/356) | 3 | 2 | 0 | `3cb92cc` format/lint; `db763ca` other (Release flow) |
