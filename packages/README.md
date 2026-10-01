# Packages

Private workspaces live here. Their dependencies stay in their own `package.json` and never go into the root `package.json`. None of them are published.

- `harness` — PGlite, a Docker Postgres topology, and schema fixtures
- `spikes` — private architecture spikes: the catalog, and inferred versus emitted row types
- `bench` — timings written as JSON, with a place for baselines
- `attest` — `@ark/attest` on TypeScript 6
