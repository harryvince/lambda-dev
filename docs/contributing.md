# Contributing

## Setup

Tool versions (Node.js, Bun, uv) are pinned in `mise.toml`.

```bash
git clone https://github.com/harryvince/lambda-dev.git
cd lambda-dev
mise install
mise run install
```

## Checks

```bash
mise run check      # typecheck, tests, and build
mise run test       # tests only
mise run typecheck  # types only
```

Tests use Vitest and never call AWS; they inject fake Lambda clients and build functions. Run `mise run check` before opening a pull request.

To try the CLI against a real function, build it and run `dist/cli.js` from a project with a `lambda-dev.yml`:

```bash
mise run build
node /path/to/lambda-dev/dist/cli.js deploy
```

## Documentation

This site is built with [Zensical](https://zensical.org). The pages are Markdown files in `docs/`, and navigation and theme settings live in `zensical.toml`.

```bash
mise run docs:serve  # live preview at http://localhost:8000
mise run docs:build  # build into site/, failing on warnings such as broken links
```

Add a new page to the `nav` list in `zensical.toml` so it appears in the sidebar.

Every push to `main` that changes `docs/` or `zensical.toml` rebuilds and deploys the site to GitHub Pages through `.github/workflows/docs.yml`. Pull requests that touch the docs are built but not deployed, so broken links fail the check before merging.

When you change user-facing behaviour, update the docs in the same pull request.

## Releasing

```bash
mise run version
```

This uses [standard-version](https://github.com/conventional-changelog/standard-version) to bump `package.json` from the commit messages since the last release, update `CHANGELOG.md`, create a `vX.Y.Z` tag, and push.

The tag triggers `.github/workflows/publish.yml`, which:

1. checks the tag matches the version in `package.json`;
2. runs `mise run check`;
3. publishes to npm with provenance, using npm trusted publishing (no npm token is stored in GitHub).

Use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:` …) so the version bump and changelog come out right. Don't also run `mise run publish` locally for the same release.
