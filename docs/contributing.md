# Contributing

## Setup

Tool versions (Node.js, Bun, uv, prek) are pinned in `mise.toml`. Node.js must be 22.20+ or 24.8+.

```bash
git clone https://github.com/harryvince/lambda-dev.git
cd lambda-dev
mise install
mise run install   # installs dependencies and the Git hooks
```

## Git hooks (mandatory)

Every commit must pass the [prek](https://prek.j178.dev) hooks in `.pre-commit-config.yaml`. `mise run install` installs them; if you cloned before they existed, run `prek install` once.

| Hook | Runs | When |
| --- | --- | --- |
| `fix` | oxfmt and `oxlint --fix` | any code, JSON, Markdown, or YAML change |
| `lint` | oxlint with the [anti-slop](#lint-rules) rules | any code change |
| `scan-deps` | Trivy (`mise run scan:deps`) | `package.json` or `bun.lock` changes |
| `scan-code` | Semgrep (`mise run scan:code`) | any code, JSON, or YAML change |

If `fix` changes files, the commit stops so you can review and stage them; commit again. Fix anything `lint` or the scans report rather than skipping it. **Don't bypass the hooks with `git commit --no-verify`.** To run every hook on the whole repository:

```bash
prek run --all-files
```

## Checks

```bash
mise run check         # format check, lint, typecheck, tests, and build
mise run fix           # apply formatting and lint autofixes
mise run lint          # oxlint only
mise run format:check  # formatting only
mise run test          # tests only
mise run typecheck     # types for src, tests, and scripts
```

Tests use Vitest and never call AWS; they inject fake Lambda clients and build functions. Run `mise run check` before opening a pull request. The publish workflow runs it too, so a release can't go out with lint or format errors.

## Lint rules

oxlint runs with the [anti-slop](https://github.com/dmmulroy/anti-slop) rules, vendored in `tools/oxlint/anti-slop/` (see its `UPSTREAM.md`). They push code to parse data where it enters the program instead of passing `unknown` around. In practice:

- **Parse external data at the boundary.** JSON goes through `parseJson` (`src/json.ts`), config and AWS responses through zod schemas. Don't narrow with `typeof`.
- **Only error-handling parameters may be `unknown`**, and they're named `cause`.
- **Every type assertion needs a `// SAFETY:` comment** just before it, stating why it holds. Prefer removing the assertion.
- **Name object types** in function signatures rather than writing them inline.
- **Build objects with explicit assignments**, not `...(condition ? { field } : {})`.
- **Blank lines** between statements and declarations are enforced and autofixed.

Never silence a rule, lower its severity, or add casts just to make lint pass. If a rule is wrong for a case, discuss changing the vendored rule.

oxfmt doesn't format `docs/**/*.md` (it would break Zensical's indented admonitions and tabs), `CHANGELOG.md`, `docs/schema.json`, or the vendored rules; see `.oxfmtrc.json`.

## Security scans

```bash
mise run scan:deps  # Trivy: known vulnerabilities in bun.lock, including dev dependencies
mise run scan:code  # Semgrep: security issues in the source and GitHub workflows
mise run scan       # both
```

Each task installs its scanner at a pinned version the first time it runs, so `mise install` stays light. Both exit non-zero when they find something.

These also run as Git hooks: `scan-deps` when dependencies change, and `scan-code` when code changes.

Most dependency findings are fixed by updating the affected package, or the package that pulls it in, and refreshing `bun.lock`. For a Semgrep finding that's a false positive, add a `// nosemgrep: <rule-id>` comment on the line with a short reason.

## Config schema

`docs/schema.json` is generated from the zod schema in `src/config.ts` and published with the docs site. After changing the config schema, regenerate it:

```bash
mise run schema
```

A test fails if the committed file is out of date. Field descriptions shown in editors come from the `.meta({ description })` calls in `src/config.ts`.

## Trying it out

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

Every push to `main` that changes `docs/` (including `schema.json`) or `zensical.toml` rebuilds and deploys the site to GitHub Pages through `.github/workflows/docs.yml`. Pull requests that touch the docs are built but not deployed, so broken links fail the check before merging.

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
