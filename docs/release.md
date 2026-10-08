# Release

Nothing in this repository publishes on push. Ali publishes after the release commit is on `main`.

The tag is `v` plus the `package.json` version. The changelog section is `## v` plus that version. The Release workflow reads the version from the checked-out commit and accepts only `refs/tags/v` plus that version. Any other ref is refused, and the message names the tag to pass.

The workflow checks the tag first, packs one tarball, then runs the Postgres matrix. The tarball job tests that same file. Supported majors are 15, 16, 17, and 18. This workflow and a weekly run (Monday 06:00 UTC) cover every supported major, suite and tarball. A pull request runs that matrix only with the label `needs: postgres`: the suite on 15 and 18 and the tarball job on 18, and that job packs its own tarball. `bun run verify` runs the suite on this machine for one version, or every supported version with `--all`. CI is the authority for a release. The tarball job installs the package in a fresh directory and runs the README and the quickstart. PGlite and the in-process wire server stay in `bun run check`. Two releases cannot run at the same time. Third-party actions are pinned by commit SHA.

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
