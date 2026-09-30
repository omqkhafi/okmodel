# Changelog

Release history for `okmodel`. One section per published tag, in reverse order.
This file is the canonical source.

Upcoming work lives under `## Unreleased`. `bun run bump` promotes that
section into `## v<version> — <YYYY-MM-DD>`. Every bullet belongs to an
`### ✨ Added` / `### 💥 Breaking Changes` / `### ♻️ Changed` / `### 🐛 Fixed`
group (also `### ⚠️ Deprecated` · `### 🔥 Removed` · `### 🔒 Security` when
needed). Large groups add `####` area headings so the list stays scannable.

## Unreleased

### ✨ Added

- Stub exports for `okmodel`, `okmodel/pg`, `okmodel/migrate`, and `okmodel/testing`.
- `okm --version` and `okmodel --version` print the package version.
- Repository checks for layer imports, core purity, docs links and decision numbers, publint, arethetypeswrong, and a `dist/` size ceiling.
