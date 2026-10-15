# AGENTS.md

Two kinds of agent read this. To **use** `opensume` (make images and video for someone), follow the first section; it is the page `opensume agent` prints. To **change** this repository, read the second.

<!-- BEGIN opensume -->
## opensume: images and video from the Sume Open API

`opensume` runs any open.sume.com model from the shell: it prices the request in dollars, waits for the job, and saves the file.

**Setup, once**

```sh
curl -fsSL https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.sh | sh
```

Windows: `irm https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.ps1 | iex`. No install, with Node 22+: put `npx -y https://github.com/sumelabs/opensume-cli/releases/latest/download/opensume.tgz` where these examples say `opensume`.

- Key: `SUME_API_KEY`, read from the environment or from `./.env`. A person makes it at https://open.sume.com/api-keys. Never print it, and never paste it into a chat or a command line.
- Host: `https://api.open.sume.com`, the default; nothing to set. Never `https://api.sume.com`: that is sume.com's API, and Open keys fail there.
- Check both: `opensume doctor`.

**Make something**

```sh
opensume models --brief                                            # pick a model: price per image or second, inputs, limits
opensume run gpt-image-2 "a red kite over a beach" -q low -o out/  # waits, saves, prints the file path
opensume run seedance-2-mini "a paper boat" -d 4 -r 480p --max-usd 0.50 -o out/ --json
```

- Name the model yourself: prices differ by more than 100× between models. Before a large spend, show the user `opensume estimate` with the same flags (free).
- `run` prints the saved file's path. With `--json` it prints `{"job", "usd", "artifacts": [{"path", "url", "content_type"}]}`; `OPENSUME_OUTPUT=json` does that without the flag.
- Cap the spend with `--max-usd`, or `OPENSUME_MAX_USD` for every run. Over the cap nothing is submitted (exit 7).
- Local files work wherever a URL does (`--image ./photo.png`, `--video`, `--audio`). Every field in `opensume schema <model>` is also a flag, like `--captions.style glass`.
- Long video: `--no-wait` returns the job id at once, and `opensume jobs wait <job> -o out/` saves it later. After a timeout (exit 6) or Ctrl-C (130) the job keeps running: resume it with `jobs wait`. Never resubmit; a second submit is a second charge.

**When it fails**

Exit codes: 1 network or server (retry), 2 bad flags, 3 key (follow `error.hint`), 4 input refused (fix what `error.message` says), 5 job failed (refunded; `opensume jobs get <job>` says why), 6 timed out, 7 balance or cap, 8 rate limit. With `--json`, errors are `{"error": {"code", "message", "hint", "request_id"}}`. Every command and flag: `opensume --help --json`. Docs: https://open.sume.com/docs
<!-- END opensume -->

## Working on this repository

`opensume` is a TypeScript CLI with no runtime dependencies (Node 22+, or a Bun-compiled binary). The API contract is `https://api.open.sume.com/v1/openapi.json`.

```sh
npm ci                 # dev tools only
npm run dev -- <args>  # run from source: npm run dev -- models --kind video
npm run check          # lint + typecheck + test + build; run it before you finish
npm run sync-schema    # refresh src/generated/router-schemas.ts from the default host
```

- `src/cli.ts` holds the command tree, global flags, `OPENSUME_OUTPUT`, error reporting and exit codes. `src/commands/*.ts` has one command per file, each a `CommandSpec`.
- `src/api/client.ts` makes every HTTP call (request ids, retries, the `data`/`error` envelope). `src/lib/body.ts` maps flags onto request fields, and `src/lib/field-flags.ts` turns `--<field>` into `--set`.
- `src/generated/router-schemas.ts` is generated; never edit it by hand. A weekly workflow fails when the API's schema moves.
- `test/helpers/mock-api.ts` is the mock Open API. Tests never call the real one.

Rules: zero runtime dependencies; erasable TypeScript, local imports end in `.ts`; all output through `ctx.ui` (results to stdout, everything else to stderr); `--json` prints exactly one document, errors included; exit codes in `src/lib/errors.ts` never change meaning; never print a key or a presigned URL. A user-visible change gets a CHANGELOG line under **Unreleased** and README updates. Bump the version in `package.json` and `src/version.ts`.

For a real API check, prefer free calls (`models`, `estimate`, `run … --dry-run`). A paid check uses the cheapest model that proves the point (`gpt-image-2 -q low`, under a cent) with `--max-usd`. If you change the page in `src/commands/agent.ts`, rerun `npm run dev -- agent --write AGENTS.md`; a test compares the two.
