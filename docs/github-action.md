# GitHub Action

The composite action `.github/actions/migrate` runs `okm migrate check` and `okm migrate plan --json` against a named target and posts one sticky pull-request comment (D279, §19.8). The comment heading is the strictest class. Each step shows its class and lock, including the row estimate the plan already prints. Lint findings keep their codes. A lint error or a failed check fails the job with that command's exit code.

`preview: true` runs `okm migrate apply --target <name>` and, when `seed` is set, `okm seed <file>`. The name is the `target` input. The action does not infer it (OKM1853) and does not hardcode `preview`. A protected target is refused by the existing policy. The action never creates or drops a database. Infrastructure creates the empty database and deletes it when the pull request closes.

## Permissions

The comment step uses the workflow's `GITHUB_TOKEN` only. The job needs:

```yaml
permissions:
  contents: read
  pull-requests: write
```

No other token is read. A URL passed as the `database-url` input can appear in the workflow file. Prefer `DATABASE_URL` from a secret. The action masks that value in the log and does not echo it.

A fork pull request receives no secrets. Preview mode is for a pull request in the same repository. The plan comment can still run when the target database is reachable without a secret, as this repository's dogfood job does.

## Plan

`target` is required. `working-directory` defaults to the workspace root. `version` empty runs the okmodel source checked out with the action. Set `version` to a published release that supports `okm migrate plan --json` to install that package instead. `comment` defaults to `true`. On a pull request the comment body contains `<!-- okmodel-migrate-plan -->` and is updated in place on the next push.

```yaml
name: Plan
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  plan:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: 1.4.2
      - uses: omqkhafi/okmodel/.github/actions/migrate@<commit>
        with:
          target: ci
        env:
          DATABASE_URL: ${{ secrets.CI_DATABASE_URL }}
```

Pin `<commit>` to the full SHA of the release you trust (D150). The action's own `setup-bun` step is already pinned. This example sets Bun up first so a later step in the same job can reuse it.

## Preview

Create the empty database outside the action, then:

```yaml
- uses: omqkhafi/okmodel/.github/actions/migrate@<commit>
  with:
    target: preview
    preview: "true"
    seed: seed.ts
  env:
    DATABASE_URL: ${{ secrets.PREVIEW_DATABASE_URL }}
```

`okm migrate apply --target preview` installs the head snapshot on an empty database (§19.6). `okm seed seed.ts` runs when `seed` is set. Deleting the database is the infrastructure's job.
