---
okmVersion: "0.10.0"
since: "0.9"
dialects: [postgres]
codes: []
---
# Using OKModel safely

Pin what you install, wait before taking a brand-new release, and read a provenance attestation as a record of the build. Report a vulnerability through the address in [SECURITY.md](../SECURITY.md).

## Pin the lockfile

Commit the lockfile (`bun.lock`, or `package-lock.json` when the app uses npm). Install from that file:

```sh
bun install --frozen-lockfile --ignore-scripts
```

```sh
npm ci --ignore-scripts
```

A range in `package.json` with no lockfile can resolve to a release published after the last review. `npm pack --dry-run` still runs the `prepack` script.

## Wait before updating

Skip a version that was published moments ago.

npm's config key is `min-release-age`. npm 11.10.0 is the first release that honours it; an older npm ignores the key and installs the newest version. The unit is days: only versions that have been available for more than that many days are eligible. In `.npmrc`:

```ini
min-release-age=3
```

`min-release-age-exclude` names packages that skip the wait.

Bun's key is `minimumReleaseAge` under `[install]` in `bunfig.toml`. The value is seconds only (`259200` is 3 days). A duration such as `3d` aborts the install. The install flag `--minimum-release-age 3d` does not: Bun ignores it and installs the newest version. Packages that skip the wait go in `minimumReleaseAgeExcludes`.

```toml
[install]
minimumReleaseAge = 259200
```

## Provenance

Provenance is the npm attestation that GitHub Actions trusted publishing built the tarball. `npm audit signatures` checks that attestation. The signed SLSA statement records the commit (`resolvedDependencies[].digest.gitCommit`). It does not prove the code is safe, that its dependencies are safe, or that a person reviewed the publish. Valid provenance did not stop [ChainDrop](https://www.stepsecurity.io/blog/chaindrop-npm-worm).
