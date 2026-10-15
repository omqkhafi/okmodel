# Release

Nothing in this repository publishes on push. Ali publishes after the release commit is on `main`.

The tag is `v` plus the `package.json` version. The changelog section is `## v` plus that version. The Release workflow reads the version from the checked-out commit and accepts only `refs/tags/v` plus that version. Any other ref is refused, and the message names the tag to pass.

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

Run the Release workflow on that tag. It refuses the run unless the tag is `v` plus the `package.json` version. It packs one tarball, runs the Postgres matrix against that file, runs `bun run check`, and publishes that same file with `npm publish ./packed/okmodel.tgz --access public` and `NPM_CONFIG_PROVENANCE=true`. `npm` performs the trusted-publisher login.

After publish, a smoke job installs `okmodel` at that version from npm in a fresh directory and runs the README quickstart against Postgres 17. It fails when the version or its provenance attestation is missing. The registry check retries at most 6 times, 10 seconds apart.

The same run then creates a GitHub Release on that tag and closes the milestone (`0.2.0` closes `0.2`, and `0.1.1` closes `0.1.1`). The notes are the body of the `## v` plus version section in `changelog.md`.

```sh
gh workflow run release.yml --ref "v${version}"
```

The same run can be started from the GitHub Actions page: open Actions, choose Release, run the workflow, and select the `v` plus version tag.

Provenance is the npm attestation that GitHub Actions built the tarball. The workflow sets `permissions.id-token` to `write` so npm can attach it.

## Site

The production site changes only after a release is published. A push to `main` does not deploy it. `site/vercel.json` sets `git.deploymentEnabled.main` to false, so the Vercel Git integration skips production for that branch. Pull requests still get preview deployments.

`.github/workflows/deploy-vercel.yml` runs when the Release workflow completes with success. It also runs when someone starts it by hand, from `main`, with a `v*` tag. The commit is the Release run's commit, or the commit that tag points at. The tag must be `v` plus the `package.json` version at that commit, and the version must be a release (`X.Y.Z`). A prerelease is refused. Those checks apply to both targets. A failed Release skips the deploy.

A manual run has `target`. `production` is the default and is what a Release run always does; that path cannot be switched to preview. `preview` is a rehearsal: the CLI pulls the preview environment, builds and deploys without `--prod`, skips the page check, and prints the deployment URL. A preview URL sits behind the Vercel login.

The Vercel project's root directory is `site`. The CLI runs from the checkout root, not from `site/`, because running it inside `site/` makes Vercel look for `site/site`. `bun install` still runs in `site/`. The site reads the repository `package.json` from the parent of `site/`, so Git preview builds need files outside that root included. This workflow builds on the runner, where the whole tag is checked out.

`production` prints the production URL and fails if that page does not contain the version. The check fetches that URL without the token, so the production site has to answer without deployment protection.

Before the first release, run the workflow by hand from main with target=preview and an existing stable tag (for example v0.6.0). It never changes the production site.

Three repository secrets. The workflow passes them through the environment and does not print them. No values belong in the repository:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

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
