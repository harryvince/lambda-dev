# Copying files

esbuild bundles JavaScript, but some code needs files at runtime that can't be bundled: native binaries, JSON schemas a dependency reads from disk, templates, or a `package.json`. List those under `build.copy` and they're copied into the build output and the zip.

```yaml
build:
  entry: src/handler.ts
  copy:
    - from: assets/native-helper # a file
      to: bin/native-helper
    - from: assets/runtime # a directory
      to: runtime
    - from: assets/schemas/**/*.json # a glob
      to: schemas
```

`from` is relative to the config file's directory. `to` is relative to the root of the zip, which is also where `index.js` sits.

## How each source is copied

**A file** is copied to exactly `to`, so `to` is the file name (with any folders in front of it).

**A directory** has its contents copied recursively into `to`, including hidden files and empty folders.

**A glob** copies every matching file. Each file keeps its path relative to the part of the pattern before the first wildcard. With `from: assets/schemas/**/*.json` and `to: schemas`:

| Source | Lands at |
| --- | --- |
| `assets/schemas/event.json` | `schemas/event.json` |
| `assets/schemas/nested/order.json` | `schemas/nested/order.json` |

Globs support `*`, `**`, `?`, character classes like `[abc]`, and braces like `*.{json,txt}`. They match files only and skip dotfiles unless the pattern names them (`assets/.*`). Quote any YAML value that starts with `*`.

Use `to: .` to put a directory's contents or a glob's matches at the zip root. A single file always needs a file name.

## Rules

The whole copy list is checked before the build starts, so a bad entry fails the build and nothing is uploaded. The build fails if:

- a source doesn't exist, or a glob matches nothing;
- a destination is absolute or contains `..`;
- two entries copy to the same place, or one copies a file where another needs a folder;
- a destination would overwrite `index.js`, `index.js.map`, or `function.zip`;
- a source is inside the build output (`outDir`), or contains it;
- any path involved is a symbolic link, including links inside a copied directory.

File contents are copied byte for byte, and permission bits, including the executable bit, are kept in both the output folder and the zip.

## Native binaries

Binaries are copied as they are, not compiled. They must already be built for Lambda's Linux environment and the function's architecture (`x86_64` or `arm64`).

## Files a dependency expects

Some packages read files relative to their own code, e.g. `__dirname + "/runtime/schema.json"`. After bundling, `__dirname` is the zip root, so copy the file to the path the code expects:

```yaml
copy:
  - from: node_modules/some-package/runtime/schema.json
    to: runtime/schema.json
```

Check the paths against the version of the package you have installed.

## Rebuilding when copied files change

`watch` only reacts to files matched by `watch.include`. To rebuild when an asset changes, add it:

```yaml
watch:
  include:
    - src/**/*.ts
    - assets/**/*
```

Files under `node_modules` are excluded from watching by default; you'd need to change `watch.exclude` too.
