# Release

A push of a tag `v*` starts the Release workflow. Nothing publishes from a branch push or a pull request. The tag is `v` plus the `package.json` version, and that commit is already on `main`. The changelog section is `## v` plus that version.

The first job fails before any build when any of these is wrong:

- the tagged commit is not an ancestor of `origin/main` (`git merge-base --is-ancestor`)
- the tag is not `v` plus the `package.json` version at that commit
- `changelog.md` has no `## v` section for that version

It then builds with Bun, runs the tracked-file pack check (`scripts/pack-tracked.ts --release`) and the pack snapshot (`scripts/pack-contract.ts`), and runs the Postgres matrix against that one tarball. Supported majors are 15, 16, 17, and 18. This workflow and a weekly run (Monday 06:00 UTC) cover every supported major, suite and tarball. The suite deals the same test files across four shards per major (`isolation`, `selection`, `consistency`, `tx`). Each shard starts its own database. The pgbouncer proof runs beside the shards, not after them. A pull request runs that matrix only with the label `needs: postgres`: the shards on 15 and 18 and the tarball job on 18, and that job packs its own tarball. `gate / check` needs those jobs and fails if one is skipped while the label is present (D230). `bun run verify` runs the suite on this machine for one version, or every supported version with `--all`. CI is the authority for a release. The tarball job installs the package in a fresh directory and runs the README and the quickstart. PGlite and the in-process wire server stay in `bun run check`. Two releases cannot run at the same time. Third-party actions are pinned by commit SHA. Dependabot opens weekly pull requests for those actions.

A dry run is `workflow_dispatch` with `publish` left false. That runs the tag job on the selected ref and does not build or stage. On `main` the ancestor check passes. A tag of a commit that is not on `main` fails.

## Tag

```sh
git checkout main
git pull
version="$(bun -e 'console.log(require("./package.json").version)')"
git tag -a "v${version}" -m "v${version}"
git push origin "v${version}"
```

## Publish

npm needs a trusted publisher for `okmodel`: repository `omqkhafi/okmodel`, workflow filename `release.yml`, environment `release`. The publisher is allowed to `npm stage publish` and is not allowed to `npm publish`. No token is stored in the repository. `bun publish` is not used: it has no OIDC exchange, no provenance, and no staging.

Pushing the tag starts the run. A dispatch can stage as well, with `publish` set true:

```sh
gh workflow run release.yml --ref "v${version}" -f publish=true
```

Leave `publish` false to dry-run the tag checks:

```sh
gh workflow run release.yml --ref main -f publish=false
```

The publish job runs only after the Postgres gate. It uses the `release` Environment. It is the only job with `id-token: write` and `contents: write`. It installs Node 22.14 or newer and npm 11.15.0 or newer, then stages the tested tarball:

```sh
npm stage publish ./packed/okmodel.tgz --access public --provenance
```

`NPM_CONFIG_PROVENANCE` is `true`. A prerelease version also passes `--tag next`, because npm refuses a prerelease without a tag. The publish step is skipped when a dispatch leaves `publish` false. Trusted publishing performs the OIDC login. The staged version is not installable until a maintainer approves it with 2FA (`npm stage approve` or the Staged Packages tab on npmjs.com).

`scripts/pack-tracked.ts --release` runs in the build job, before the tarball is uploaded. It refuses a dirty worktree (including untracked files) and any packed path outside `dist/` that git does not track. `scripts/pack-contract.ts` runs in that job and in `gate / check`. It runs `bunx npm pack --dry-run --json` and fails unless the file list and the `exports` map match `tests/fixtures/pack-contract.snap.json`. It also fails when `package.json` sets `preinstall`, `install`, `postinstall`, or `prepare`, when `dependencies` is not empty, when a peer dependency is not optional, or when the `files` allowlist is missing. Update the snapshot with `bun ./scripts/pack-contract.ts --update` and commit it. `bun pm pack` writes no `gitHead`, so the commit is not in the tarball. The tarball job tests the uploaded file. Publish uploads that same file.

After a maintainer approves the staged version, `scripts/npm-smoke.ts` installs `okmodel` at that version from npm in a fresh directory and runs the README quickstart against Postgres 17. It fails when the version or its provenance attestation is missing. `npm view` only returns the predicate type. The script then reads the document at `dist.attestations.url` and fails when the SLSA statement's `gitCommit` (`resolvedDependencies[].digest.gitCommit`) is not the tagged commit. A different SHA fails immediately. npm can return from approval while the version is still processing. The script asks again at most 31 times, 30 seconds apart, and each install runs `bun add --no-cache` so a manifest cached before the version existed is not reused. Set `RELEASE_COMMIT` to the full SHA of the tag.

The same workflow run creates a GitHub Release on that tag. A stable version closes the milestone (`0.2.0` closes `0.2`, and `0.1.1` closes `0.1.1`). A prerelease does not. The notes are the body of the `## v` plus version section in `changelog.md`.

Provenance is the npm attestation that GitHub Actions built the tarball. The publish job sets `permissions.id-token` to `write` so npm can attach it. The signed statement records the commit the runner built.

The last job runs `scripts/verify-release.ts` with the `package.json` version. It downloads that version from the registry and packs a clean `git archive` of the tag (`bun install --frozen-lockfile`, `bun run build`, `bun pm pack`, with the pinned Bun). It fails when the file bytes differ, when the tarball's `package.json` version differs, or when the packed paths differ from the pack-contract snapshot on that tag. A gzip wrapper that differs while every file byte matches still passes. A tag with no snapshot warns. `npm audit signatures` must report a verified attestation. That is the provenance check. `npm view --json` shows the predicate type and does not verify the signature. Tag `v0.9.1` is not an ancestor of `main`, and that known fact is a warning. Any other tag off `main` fails. A staged version is not on the registry until a maintainer approves it, so this job fails until the version is public and the job is run again.

```sh
bun ./scripts/verify-release.ts 0.10.0
```

## Site

The production site changes only after a release is published. A push to `main` does not deploy it. The Vercel production branch is `release`. Set that in the Vercel project under Settings, Environments, Production, Branch Tracking. `site/vercel.json` sets `git.deploymentEnabled.main` to false, so a forgotten production-branch setting still does not publish `main`. Pull requests still get preview deployments.

`.github/workflows/deploy-vercel.yml` runs when the Release workflow completes with success. It also runs when someone starts it by hand, from `main`, with a `v*` tag. The commit is the Release run's commit, or the commit that tag points at. The tag must be `v` plus the `package.json` version at that commit, and the version must be a release (`X.Y.Z`). A prerelease is refused. A failed Release skips the job.

The job checks the tag, then moves `release` to that commit. The first push creates the branch. Vercel builds `release` because that branch is production. The job then fetches the origin declared in `site/lib/site-identity.ts` (`https://okm.omqkhafi.dev`) until the page contains the released version. The pauses grow from 10 seconds to 60 seconds, and the wait stops at 12 minutes. The job fails if the version does not show up. The fetch does not use a token, so the production site has to answer without deployment protection.

A manual run takes the same `tag` input and does the same move. It has no target. It updates the production site.

To rehearse, push any older tag's commit to a branch such as `preview-test` and look at that deployment in Vercel. Never push a rehearsal to `release`.

```sh
git push origin "v0.6.0^{commit}:refs/heads/preview-test"
```

The Vercel project is already linked to this GitHub repository. The workflow stores no Vercel token.

## Dry run

Before the tag, from the commit you are about to tag:

```sh
bun run build
bun pm pack
bun run publish:dry
bun run publint
bun run attw
```

`publint` and `attw` pack the tarball themselves. `bun run check` runs both.
