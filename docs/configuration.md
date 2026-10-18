# Configuration

The CLI reads `lambda-dev.yml` from the current directory, or the path given with `--config`. All relative paths in it (the handler, payload files, copy sources, watch globs) resolve from **the directory containing the config file**, not from where you run the command.

Unknown keys are rejected, so typos fail validation instead of being silently ignored.

## Editor support

A [JSON Schema](https://harryvince.github.io/lambda-dev/schema.json) for `lambda-dev.yml` gives you autocomplete, descriptions on hover, and errors as you type, in any editor that uses the [YAML language server](https://github.com/redhat-developer/yaml-language-server) (VS Code with the Red Hat YAML extension, Neovim, Zed, Helix, and others).

Configs created by `init` already start with this line, which is all those editors need:

```yaml
# yaml-language-server: $schema=https://harryvince.github.io/lambda-dev/schema.json
```

To apply the schema without the comment, map it to the file name in your editor instead. In VS Code, add this to `settings.json`:

```json
{
  "yaml.schemas": {
    "https://harryvince.github.io/lambda-dev/schema.json": "lambda-dev.yml"
  }
}
```

In JetBrains IDEs, add the URL under **Settings → Languages & Frameworks → Schemas and DTDs → JSON Schema Mappings**.

The schema is generated from the same definition the CLI validates with. It checks everything except a few things that need the file system or AWS, such as whether `entry` exists or the 4 KB environment limit, so still run `validate` before relying on a config.

## Full example

```yaml title="lambda-dev.yml"
# yaml-language-server: $schema=https://harryvince.github.io/lambda-dev/schema.json
version: 1
defaultTarget: dev
targets:
  dev:
    functionName: my-existing-lambda-dev
    region: eu-west-2
    profile: default
    environment:
      LOG_LEVEL: debug
    build:
      entry: src/handler.ts
      bundle: true
      platform: node
      target: node20
      format: cjs
      sourcemap: true
      minify: false
      external:
        - "@aws-sdk/*"
      define:
        process.env.STAGE: '"dev"'
      copy:
        - from: assets/runtime
          to: runtime
    watch:
      include:
        - src/**/*.ts
      exclude:
        - dist/**
        - node_modules/**
        - .lambda-dev/**
      debounceMs: 300
    invoke:
      afterDeploy: true
      payloadFile: events/dev.json
      logType: Tail
```

## Top level

| Key | Required | Description |
| --- | --- | --- |
| `version` | Yes | Must be `1`. |
| `defaultTarget` | No | Target used when none is passed on the command line. |
| `targets` | Yes | Map of target name to target settings. At least one is required. |

## Target

A target is one Lambda function. Use several targets for several functions, or for the same code in different accounts or regions.

| Key | Required | Description |
| --- | --- | --- |
| `functionName` | Yes | Name or ARN of an existing function. |
| `region` | Yes | AWS region, e.g. `eu-west-2`. |
| `profile` | No | Named profile from your AWS config. Without it, the default AWS SDK credential chain is used. |
| `environment` | No | Environment variables to set or delete. See [Environment variables](environment-variables.md). |
| `snapshot` | No | Default `true`. Save the function's code and environment before the first deploy, so [`rollback`](rollback.md) can restore them. |
| `build` | Yes | See [`build`](#build). |
| `watch` | No | See [`watch`](#watch). |
| `invoke` | No | See [`invoke`](#invoke). |

!!! danger "No secrets in this file"
    Don't put AWS keys, secrets, or production data in `lambda-dev.yml`. Use `profile` or your normal credential setup for AWS access.

## `build`

Options passed to esbuild. The output is always a single `index.js` (plus `index.js.map` when `sourcemap` is on) at the root of the zip.

| Key | Default | Description |
| --- | --- | --- |
| `entry` | (required) | Handler source file. |
| `bundle` | `true` | Bundle dependencies into `index.js`. |
| `platform` | `node` | `node`, `browser`, or `neutral`. |
| `target` | `node20` | esbuild target, e.g. `node22`. Match your function's runtime. |
| `format` | `cjs` | `cjs`, `esm`, or `iife`. |
| `sourcemap` | `true` | Emit and ship `index.js.map`. |
| `minify` | `false` | Minify the bundle. |
| `external` | `[]` | Packages to leave out of the bundle, e.g. `"@aws-sdk/*"`. |
| `define` | `{}` | esbuild `define` replacements. Values are code, so strings need inner quotes: `'"dev"'`. |
| `copy` | `[]` | Extra files to put in the zip. See [Copying files](copying-files.md). |
| `cache` | `true` | Reuse the zip from an earlier build with the same options and unchanged inputs. See [Build cache](#build-cache). |
| `outDir` | `.lambda-dev/<target>` | Build output directory. It's deleted and recreated on every build, so it can't contain `.lambda-dev/snapshots` or `.lambda-dev/build-cache`. |

!!! warning "`format: esm`"
    The zip doesn't include a `package.json`, so whether Lambda treats `index.js` as an ES module depends on the Node.js runtime. `cjs` is the safe default. If you need `esm`, [copy](copying-files.md) in a `package.json` with `"type": "module"`.

### Build cache

Every build is saved in `.lambda-dev/build-cache/`. Before building, the CLI looks for an earlier build, by this target or any other, with:

- the same `build` options (everything except `outDir` and `cache`) and the same `copy` layout;
- the same contents in every file esbuild bundled and every file copied;
- the same `package.json`, `tsconfig.json`, `jsconfig.json`, and lockfiles in the config's directory and each directory above it;
- the same esbuild version.

If one matches, its zip is reused and the output directory is recreated from it, and the log says `Reused cached build`. So deploying the same code to `dev`, `staging`, and `prod` builds once and uploads byte-identical zips, which also gives each function the same `CodeSha256`. Targets that differ in any build option, such as a per-stage `define`, are built separately.

The cache keeps the 20 most recently written builds. Set `cache: false` on a target, or pass `--no-cache` to `deploy`, to always rebuild. Deleting `.lambda-dev/build-cache/` is always safe.

!!! note
    The cache tracks file contents, not which files exist. A new file that changes how an import resolves without changing any tracked file (say, adding `src/util.ts` next to an existing `src/util/index.ts`) isn't noticed. Deploy with `--no-cache` after a change like that.

## `watch`

| Key | Default | Description |
| --- | --- | --- |
| `include` | `["src/**/*"]` | Globs of files that trigger a deploy. |
| `exclude` | `["node_modules/**", "dist/**", ".lambda-dev/**"]` | Globs to ignore, even if included. |
| `debounceMs` | `300` | Quiet period after the last change before deploying. |

Globs use the same syntax as [`build.copy`](copying-files.md): `*`, `**`, `?`, character classes like `[abc]`, and braces like `*.{ts,json}`. Like copy globs, they skip dotfiles unless the pattern names them (`src/.env`), so editor swap files such as `.handler.ts.swp` don't trigger deploys. An exclude ending in `/**` also skips the directory itself, so the watcher never walks into it. Keep your build output excluded, or each build will trigger another.

## `invoke`

| Key | Default | Description |
| --- | --- | --- |
| `afterDeploy` | `false` | Invoke after every `deploy` and `watch` cycle. |
| `payloadFile` | none | JSON file to send as the event. |
| `payloadJson` | none | Inline event, written as YAML, sent as JSON. Takes priority over any payload file. A string is sent as a JSON string. |
| `logType` | `Tail` | `Tail` asks Lambda to return the last 4 KB of logs with the response, `None` doesn't. The CLI currently reports that logs are available but doesn't print them. |

See [Payloads](commands.md#payloads) for how command-line flags interact with these.

## Sharing settings between targets

YAML anchors (`&name`) and aliases (`*name`) let targets reuse blocks. Merge keys (`<<`) let a target override individual values:

```yaml
# yaml-language-server: $schema=https://harryvince.github.io/lambda-dev/schema.json
version: 1
defaultTarget: dev
targets:
  dev:
    functionName: my-lambda-dev
    region: eu-west-2
    build: &sharedBuild
      entry: src/handler.ts
      copy: &sharedCopy
        - from: assets/runtime
          to: runtime
  staging:
    functionName: my-lambda-staging
    region: eu-west-2
    build:
      <<: *sharedBuild
      minify: true
      copy: *sharedCopy
```

- Define an anchor before using it.
- Values written next to `<<` override merged ones.
- To merge several blocks, use `<<: [*first, *second]`; earlier ones win.
- Merges are shallow: nested maps need their own merge, and lists are replaced, not combined.
- Anchors must live inside real config keys. A top-level `defaults:` block is rejected as an unknown key.
