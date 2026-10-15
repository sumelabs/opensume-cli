# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.3] - 2026-10-15

Synced with the Open API as it is now: Open has its own production stack.

### Changed

- The default API host is Open production, `https://api.open.sume.com` (it was Sume's development API, `https://api.dev.sume.com`). The development API still works with `--base-url`, `SUME_API_BASE_URL` or `opensume auth login --base-url`; it has models in preview and its own keys. While open.sume.com is in preview, its keys are development keys. README → API hosts lists both.
- `npm run sync-schema` reads the default host's OpenAPI. The vendored request schemas already matched both hosts.

### Added

- A refused key names the other host to try, in run errors, `auth status` (also `error.hint` in `--json`) and `doctor`: a key works only on the stack it was made for.
- `doctor` shows the API's release next to its build, such as `build 5fadc7571 (open-v0.2.0)`.

### Fixed

- The README's prices: `gpt-image-2` at low quality costs $0.012 now.

## [0.2.2] - 2026-10-15

### Fixed

- A failed job's hint points at `opensume jobs get <id>`, which shows the reason, and says it is refunded. `jobs events` prints the job's error under a `job.failed` event, since the API's event does not carry it.

## [0.2.1] - 2026-10-15

Found by using 0.2.0 against api.dev.

### Fixed

- After a definite refusal (any 4xx), errors no longer suggest rerunning with the idempotency key: nothing was created. The key is named only when the outcome is uncertain (network errors, 5xx, interrupts).
- A submit that matched an earlier one by idempotency key says its price was paid by the first submit, and `--json` marks it `idempotency_hit: true`.
- `--timeout` names the job to resume once, not twice.
- Canceling a job whose generation already started explains that it will finish or fail on its own.

## [0.2.0] - 2026-10-15

Found by running every model on api.dev through the published 0.1.0, and by holding the CLI up against fal's genmedia.

### Added

- `opensume schema <model>` (alias `inputs`): every field the model's endpoint takes, with its type, limits, choices and the flag that sets it. `--full` gives whole descriptions; `--json` gives the schema. `opensume run <model> --help` ends with the same table. The schema ships in the CLI and works offline (`npm run sync-schema` refreshes it).
- `--logs` on `run` and `jobs wait`: the job's events as they happen. With `--json`, they are added to the document as `events`.
- `jobs events --follow` (alias `jobs logs`): tails a job until it ends; with `--json`, one event per line.
- `-o` templates: `{model}`, `{job}`, `{job_id}`, `{index}`, `{ext}`, `{type}`. A bad template is refused before anything is submitted.
- `opensume upload <url>`: copies a remote file into Sume storage.
- `opensume doctor`: checks the version, config, API host and build, catalog, key and media host; exits non-zero on a failure.
- Job ids may be shortened to a unique start, such as the 8 characters in a file name.

### Fixed

- `--set` values follow the field's type, so `--set prompt=1984` stays text. Unknown fields get a warning with a suggestion before they are priced or sent; the free estimate silently ignores them.
- A job that the provider refuses at submit (for example a retired model) is reported as a failed job, exit 5, instead of a retryable server error.
- Server errors suggest a retry only when the API says the request is retryable.
- A video's poster image is skipped by default even when the API does not label it (vidu-q4).

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

[Unreleased]: https://github.com/sumelabs/opensume-cli/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/sumelabs/opensume-cli/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/sumelabs/opensume-cli/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sumelabs/opensume-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sumelabs/opensume-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sumelabs/opensume-cli/releases/tag/v0.1.0
