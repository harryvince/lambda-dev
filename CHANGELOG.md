# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [2.3.0](https://github.com/harryvince/lambda-dev/compare/v2.2.0...v2.3.0) (2026-10-18)


### Features

* add a build command that builds a target without deploying it ([4d74663](https://github.com/harryvince/lambda-dev/commit/4d74663078f5ec007b99e1ea0cf890d763bae205))
* add response checks for deployment validation ([5aa2efb](https://github.com/harryvince/lambda-dev/commit/5aa2efb13b92a39d1fa019cd05b7f04fa9a0c05b))

## [2.2.0](https://github.com/harryvince/lambda-dev/compare/v2.1.0...v2.2.0) (2026-10-18)


### Features

* cache builds so targets with identical inputs reuse one zip ([ab31411](https://github.com/harryvince/lambda-dev/commit/ab31411b8025ba6b79b755ec7d178c9fff176e06))

## [2.1.0](https://github.com/harryvince/lambda-dev/compare/v2.0.0...v2.1.0) (2026-10-18)


### Features

* add rollback to restore a function's original code and environment ([18fb103](https://github.com/harryvince/lambda-dev/commit/18fb1031079a29ffd04b45414e648dce2ee8e233))

## [2.0.0](https://github.com/harryvince/lambda-dev/compare/v1.2.2...v2.0.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* the CLI requires Node.js ^22.20.0 || >=24.8.0, and watch globs no longer match dotfiles implicitly.
* string invoke payloads are sent as JSON strings rather than raw text.

### Features

* publish a JSON Schema for lambda-dev.yml ([55dfb6b](https://github.com/harryvince/lambda-dev/commit/55dfb6bd8b5fdd5aa8be532e577223dec4fe2431))
* require Node 22.20+ or 24.8+ and use built-in globbing ([56564a5](https://github.com/harryvince/lambda-dev/commit/56564a5759b67125ce9121e43e315c70c7fd5002))


### Bug Fixes

* parse external data at boundaries to satisfy anti-slop rules ([01e42c1](https://github.com/harryvince/lambda-dev/commit/01e42c1345b5966f5a294f61c406788f09700b1c))

### [1.2.2](https://github.com/harryvince/lambda-dev/compare/v1.2.1...v1.2.2) (2026-10-18)

### [1.2.1](https://github.com/harryvince/lambda-dev/compare/v1.2.0...v1.2.1) (2026-10-16)


### Bug Fixes

* vuln with adm-zip ([dc88529](https://github.com/harryvince/lambda-dev/commit/dc885296724579ce7d4a66283f3f85007819868b))

## [1.2.0](https://github.com/harryvince/lambda-dev/compare/v1.1.0...v1.2.0) (2026-10-15)


### Features

* support Lambda environment variable updates ([12009e1](https://github.com/harryvince/lambda-dev/commit/12009e11be82ddce8d7e5fe9a7f5e3b50530fb91))

## [1.1.0](https://github.com/harryvince/lambda-dev/compare/v1.0.2...v1.1.0) (2026-10-15)


### Features

* implement copy-plugin from eslint ([06d0830](https://github.com/harryvince/lambda-dev/commit/06d0830b76ce733c105289d16fa7b4e893f4f387))

### [1.0.2](https://github.com/harryvince/lambda-dev/compare/v1.0.1...v1.0.2) (2026-06-30)

### Bug Fixes

- watch feature ([9710a0a](https://github.com/harryvince/lambda-dev/commit/9710a0aca6e11cbdfd7a096db28e0d78424be986))

### [1.0.1](https://github.com/harryvince/lambda-dev/compare/v1.0.0...v1.0.1) (2026-06-30)

### Bug Fixes

- command invocation not doing anything ([aec3e7b](https://github.com/harryvince/lambda-dev/commit/aec3e7b9ad1474fde08f5f00babc4d39b233e0de))

## 1.0.0 (2026-06-30)

### Features

- implement tool to dev with lambdas 148e9da
