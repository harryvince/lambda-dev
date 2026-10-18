# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13)
- Copied from: `skills/install-anti-slop/assets/anti-slop/` via `skills/install-anti-slop/scripts/install.mjs`
- Installed at: `tools/oxlint/anti-slop/`, registered in `.oxlintrc.json`
- Licence: MIT (`LICENSE`); `vendor/eslint-stylistic/` keeps its own licence and provenance

## Local deviations

- Removed `effect/`: this project doesn't use Effect, so the opt-in Effect rules are not installed.
- Oxlint and `@oxlint/plugins` are pinned at 1.88.0 (upstream tested with 1.78.0).
- `rules/require-safety-comment-for-type-assertion.ts`: added a `nosemgrep` comment on `markerPattern`'s `RegExp`, a Semgrep false positive (markers are escaped and come from the lint config).

These files are vendored and owned by this repository. To pick up upstream changes, follow the upstream skill's update procedure (`skills/install-anti-slop/references/update.md`) rather than overwriting this directory.
