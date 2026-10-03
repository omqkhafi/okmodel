# Release

Nothing in this repository publishes on push. Ali publishes after the release commit is on `main`.

The tag is `v` plus the `package.json` version. The changelog section is `## v` plus that version. The Release workflow reads the version from the checked-out commit and accepts only `refs/tags/v` plus that version. Any other ref is refused, and the message names the tag to pass.

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

Run the Release workflow on that tag. It checks out the commit, refuses the run unless the tag is `v` plus `package.json` version, runs `bun run check`, and runs `npm publish --access public` with `NPM_CONFIG_PROVENANCE=true`. `npm` performs the trusted-publisher login.

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
