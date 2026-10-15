# Contributing to opensume

Thanks for helping. This guide covers how to set up the project, how changes get in, and what a release takes.

- **Questions and ideas.** Open an issue with the **Feature request** form.
- **Bugs.** Use the **Bug report** form. Include `opensume version` and the request id the error printed.
- **Security problems.** Do not open an issue. Follow [SECURITY.md](SECURITY.md).
- **API behavior.** If the Sume Open API itself misbehaves (a wrong price, a job that never finishes), say so in the issue and quote the request id. We route it to the API team.

## Set up

You need Node.js 22.6 or newer and npm (`npm run dev` relies on Node's type stripping; the built CLI runs on any Node 22). [Bun](https://bun.sh) is only needed to build the standalone binaries.

```sh
git clone https://github.com/sumelabs/opensume-cli.git
cd opensume-cli
npm ci
npm run dev -- --help      # run the CLI from source
```

`npm run dev -- <args>` runs `src/bin.ts` directly through Node's type stripping, with no build step. To try the built version, run `npm run build`, then `node dist/bin.js <args>`, or `npm link` to put `opensume` on your PATH.

To call the real API, export a key from [open.sume.com → API keys](https://open.sume.com/api-keys) as `SUME_API_KEY`. Use `opensume estimate` or `--dry-run` while you iterate: both are free.

## Project layout

```text
src/
  bin.ts          entry point: runs main() and sets the exit code
  cli.ts          the command tree, global flags, help, errors → exit codes
  context.ts      what every command receives: UI, settings, API client
  commands/       one file per command (run, estimate, models, jobs, …)
  api/            the HTTP client, API types and API errors
  lib/            argument parsing, help, request bodies, polling,
                  downloads, uploads, config, terminal UI
test/
  helpers/        a mock Open API server and an in-process CLI runner
  *.test.ts       unit tests and end-to-end CLI tests
scripts/          binary builds
install.sh        installer for macOS and Linux
install.ps1       installer for Windows
skills/           a skill that teaches coding agents to use the CLI
```

## Conventions

- **No runtime dependencies.** The CLI uses Node's standard library and `fetch` only. A new dependency needs a strong reason in the PR.
- **TypeScript, strict.** The code must run under Node's type stripping, so use only erasable syntax: no `enum`, `namespace` or parameter properties. Import local files with their `.ts` extension.
- **Output.** Results go to stdout. Progress, notes and errors go to stderr through `ctx.ui`. Never call `console.log`; Biome rejects it.
- **`--json`.** Every command prints exactly one JSON document on stdout in `--json` mode, errors included. Keep its fields stable: scripts depend on them.
- **Exit codes** are a contract. They are listed in `src/lib/errors.ts` and the README. Never change what an existing code means.
- **Help text** is generated from the command specs. A new command or flag needs a `summary` or `description`, and examples where they help. `opensume --help --json` is generated from the same specs, so it stays in sync by itself.
- **Secrets.** Never print, log or store an API key outside the config file. Never log a presigned upload URL.
- **Style.** Biome formats and lints. Run `npm run lint:fix` before you commit.

## Tests

```sh
npm test            # unit and end-to-end tests, about a second
npm run check       # lint, typecheck, test and build: what CI runs
```

End-to-end tests run the real `main()` against `test/helpers/mock-api.ts`, a local stand-in for the Open API, so they need no key and spend nothing. When you change how the CLI talks to the API, update the mock to match the API's documented behavior, and add a test that covers the change.

## Pull requests

1. Branch from `main`.
2. Keep each PR to one change, with tests.
3. Use a [Conventional Commits](https://www.conventionalcommits.org/) title: `feat: …`, `fix: …`, `docs: …`, `chore: …`. PRs are squash-merged, so the title becomes the commit.
4. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
5. CI must pass. It runs lint and typecheck, tests on Linux, macOS and Windows with Node 22 and 24, and a standalone binary build.

## Releases

Maintainers release from `main`:

1. Move the **Unreleased** notes in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading.
2. Set the same version in `package.json` and `src/version.ts`. A test checks that they match.
3. Merge, then tag the merge commit: `git tag vx.y.z && git push origin vx.y.z`.

The [Release workflow](.github/workflows/release.yml) then:

1. Checks that the tag, `package.json` and the changelog agree.
2. Runs every check.
3. Builds and smoke-tests a binary on each platform (musl builds inside Alpine).
4. Publishes the binaries with `checksums.txt`, build provenance and the changelog section as release notes.
5. Installs the release with `install.sh` (macOS, Ubuntu, Alpine), `install.ps1` (PowerShell 7 and Windows PowerShell 5.1) and npm, to prove each path works.

To rehearse a release without publishing anything, run the workflow by hand with **dry run** checked.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
