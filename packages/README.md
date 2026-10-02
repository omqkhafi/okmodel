# Packages

Private workspaces live here. Their dependencies stay in their own `package.json` and never go into the root `package.json`. None of them are published.

- `harness` — PGlite, a Docker Postgres topology, and schema fixtures
- `spikes` — private row-type and operator fixtures for the type-cost ceilings. The rest of the M0 spikes are on the `m0-spikes` tag; findings stay in `docs/`
- `bench` — timings written as JSON, with a place for baselines
- `attest` — `@ark/attest` on TypeScript 6
