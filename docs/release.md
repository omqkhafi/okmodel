# Release

Nothing in this repository publishes on push. Ali publishes after the release commit is on `main`.

The tag is `v` plus the `package.json` version. The changelog section is `## v` plus that version. The Release workflow takes the commit that was QA'd and reads `package.json` at that commit. It accepts only `refs/tags/v` plus that version, and only when the tag peels to that commit. Any other ref is refused, and the message names the command to run.

The workflow checks the tag first, packs one tarball, then runs the Postgres matrix. The tarball job tests that same file. Supported majors are 15, 16, 17, and 18. This workflow and a weekly run (Monday 06:00 UTC) cover every supported major, suite and tarball. The suite deals the same test files across four shards per major (`isolation`, `selection`, `consistency`, `tx`). Each shard starts its own database. The pgbouncer proof runs beside the shards, not after them. A pull request runs that matrix only with the label `needs: postgres`: the shards on 15 and 18 and the tarball job on 18, and that job packs its own tarball. `gate / check` needs those jobs and fails if one is skipped while the label is present (D230). `bun run verify` runs the suite on this machine for one version, or every supported version with `--all`. CI is the authority for a release. The tarball job installs the package in a fresh directory and runs the README and the quickstart. PGlite and the in-process wire server stay in `bun run check`. Two releases cannot run at the same time. Third-party actions are pinned by commit SHA.

## Tag

```sh
git checkout main
git pull
version="$(bun -e 'console.log(require("./package.json").version)')"
git tag -a "v${version}" -m "v${version}"
git push origin "v${version}"
```

## Publish

npm needs a trusted publisher for `okmodel`: repository `omqkhafi/okmodel`, workflow `release.yml`. No token is stored in the repository.

`<sha>` is the commit that was QA'd: `git rev-parse "v${version}^{commit}"`. Run the Release workflow on that tag and pass the SHA:

```sh
gh workflow run release.yml --ref "v${version}" -f commit=<sha>
```

The same run can be started from the GitHub Actions page: open Actions, choose Release, run the workflow, select the `v` plus version tag, and paste that SHA into `commit`.

The tag job refuses the run when:

- `commit` is missing or is not a full 40-hex SHA
- the tag does not peel to that commit (`v${version}^{commit}`)
- the checkout is a different commit, so the tarball would not be built from the QA'd commit
- `package.json` at that commit is not the version in the tag, or the ref is not `refs/tags/v` plus that version

It then packs one tarball and runs the Postgres matrix against that file. `bun pm pack` writes no `gitHead`, so the commit is not in the tarball. The publish job runs `bun run check`, then `scripts/pack-tracked.ts --release`, which refuses a dirty worktree (including untracked files) and any packed path outside `dist/` that git does not track. It publishes the tag job's tarball with `npm publish ./packed/okmodel.tgz --access public` and `NPM_CONFIG_PROVENANCE=true`. `npm` performs the trusted-publisher login.

After publish, a smoke job installs `okmodel` at that version from npm in a fresh directory and runs the README quickstart against Postgres 17. It fails when the version or its provenance attestation is missing. `npm view` only returns the predicate type. The smoke job then reads the document at `dist.attestations.url` and fails when the SLSA statement's `gitCommit` (`resolvedDependencies[].digest.gitCommit`) is not `<sha>`. A different SHA fails immediately. A version that has not propagated yet is retried at most 6 times, 10 seconds apart.

The same run then creates a GitHub Release on that tag and closes the milestone (`0.2.0` closes `0.2`, and `0.1.1` closes `0.1.1`). The notes are the body of the `## v` plus version section in `changelog.md`.

Provenance is the npm attestation that GitHub Actions built the tarball. The workflow sets `permissions.id-token` to `write` so npm can attach it. The signed statement records the commit the runner built.

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
