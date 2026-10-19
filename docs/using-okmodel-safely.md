# Using OKModel safely

Pin what you install, wait before taking a brand-new release, and read a provenance attestation as a record of the build. Report a vulnerability through the address in [SECURITY.md](../SECURITY.md).

## Pin the lockfile

Commit the lockfile (`bun.lock`, or `package-lock.json` when the app uses npm). Install from that file:

```sh
bun install --frozen-lockfile
```

```sh
npm ci
```

A range in `package.json` with no lockfile can resolve to a release published after the last review.

## Wait before updating

Skip a version that was published moments ago.

npm's config key is `min-release-age`. The unit is days: only versions that have been available for more than that many days are eligible. In `.npmrc`:

```ini
min-release-age=3
```

`min-release-age-exclude` names packages that skip the wait.

Bun's key is `minimumReleaseAge` under `[install]` in `bunfig.toml`. A number is seconds (`259200` is 3 days). A duration string such as `3d` is also accepted. The install flag is `--minimum-release-age`. Packages that skip the wait go in `minimumReleaseAgeExcludes`.

```toml
[install]
minimumReleaseAge = 259200
```

## Provenance

Provenance is the npm attestation that GitHub Actions trusted publishing built the tarball. The signed SLSA statement records the commit (`resolvedDependencies[].digest.gitCommit`). It does not prove the code is safe, that its dependencies are safe, or that a person reviewed the publish. valid provenance did not stop ChainDrop.
