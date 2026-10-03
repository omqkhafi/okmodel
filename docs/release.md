# Release 0.1.0

Nothing in this repository publishes on push. Ali publishes after the release commit is on `main`.

The version in `package.json` is `0.1.0`. The changelog section is `## v0.1.0`.

## Tag

```sh
git checkout main
git pull
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

## Publish

npm needs a trusted publisher for `okmodel`: repository `omqkhafi/okmodel`, workflow `release.yml`. No token is stored in the repository.

Run the Release workflow on the tag. It checks out that commit, runs `bun run check`, and runs `npm publish --access public` with `NPM_CONFIG_PROVENANCE=true`. `npm` performs the trusted-publisher login.

```sh
gh workflow run release.yml --ref v0.1.0
```

The same run can be started from the GitHub Actions page: open Actions, choose Release, run the workflow, and select the `v0.1.0` tag. The workflow refuses any other ref.

Provenance is the npm attestation that GitHub Actions built the tarball. The workflow sets `permissions.id-token` to `write` so npm can attach it.

## Dry run

Before the tag, from a commit whose `package.json` version is `0.1.0`:

```sh
bun run build
bun pm pack
bun run publish:dry
bun run publint
bun run attw
```

`publint` and `attw` pack the tarball themselves. `bun run check` runs both.
