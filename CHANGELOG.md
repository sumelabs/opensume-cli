# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-15

The first release: every model on open.sume.com, from the terminal.

### Added

- `opensume run <model> [prompt]`: submit to the image or video router, wait, and save the file. Media flags take a URL or a local file, and local files are uploaded first. Submits carry an Idempotency-Key and are retried safely. Includes `--max-usd`, `--dry-run`, `--no-wait`, `--timeout`, `--open` and `--all-files`.
- Polling follows the API's hint, capped at 5 s, 10 s or 15 s by how long the wait has run, so early finishes are noticed early.
- `opensume estimate`: the dollar price of a request, free and with no key. It warns when the API priced a different duration or resolution than the one asked for.
- `opensume models`: the open catalog with prices, filters, and a detail view per model.
- `opensume jobs list | get | status | wait | cancel | events`.
- `opensume upload`: direct upload to Sume storage.
- `opensume auth login | status | logout`, with an owner-only config file.
- `--json` on every command, with errors as JSON too; documented exit codes; `opensume --help --json` command manifest.
- Shell completion for bash, zsh and fish, with model ids.
- Standalone binaries for macOS (arm64, x64), Linux (x64, arm64; glibc and musl) and Windows x64, built to run on CPUs without AVX2. Checksum-verified `install.sh` and `install.ps1`, an npm tarball on each release, and `opensume update`.
- An agent skill in `skills/opensume`.

[Unreleased]: https://github.com/sumelabs/opensume-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sumelabs/opensume-cli/releases/tag/v0.1.0
