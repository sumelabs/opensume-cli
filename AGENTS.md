# AGENTS.md

Two kinds of agent read this. To **use** `opensume` (make images and video for someone), follow the first section; it is the page `opensume agent` prints. To **change** this repository, read the second.

<!-- BEGIN opensume -->
## opensume: the Sume Open API from the shell

Images, video, lip-sync and captions from every open.sume.com model, priced in dollars. Every command takes `--json`.

**Install**

```sh
curl -fsSL https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.sh | sh
```

Windows: `irm https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.ps1 | iex`. Node 22+: `npm install -g https://github.com/sumelabs/opensume-cli/releases/latest/download/opensume.tgz`.

**API**

- Base URL: `https://api.open.sume.com`, the default. `SUME_API_BASE_URL` or `--base-url` changes it.
- Not `https://api.sume.com`: that is sume.com's API, not Open's, and Open keys do not work there.
- `https://open-api-development.up.railway.app` is Open's development API, for Sume staff, with its own keys (open.dev.sume.com).
- Docs: https://open.sume.com/docs

**Key**

- The CLI reads it from `SUME_API_KEY` (made at https://open.sume.com/api-keys). Never paste a key into a chat, a file in the repo, or a command line.
- Or save it once: `printenv SUME_API_KEY | opensume auth login --with-key`.
- Check it: `opensume auth status --json` answers `valid: true`.
- Raw HTTP sends it as `Authorization: Bearer $SUME_API_KEY`.

**Use**

```sh
opensume models --json                                         # models, kinds and prices
opensume schema <model> --json                                 # every input; each one is also a flag
opensume estimate <model> "<prompt>" --json                    # the price in dollars, free
opensume run <model> "<prompt>" --max-usd 0.10 -o out/ --json  # submit, wait, save the file
opensume jobs wait <job_id> -o out/ --json                     # pick up a long or interrupted job
```

- Always pass `--max-usd`; over it, nothing is submitted (exit 7). A second submit is a second charge: resume with `jobs wait`.
- Exit codes: 0 ok, 2 bad flags, 3 key, 4 input refused, 5 job failed (refunded), 6 timed out, 7 funds or `--max-usd`, 8 rate limit, 130 interrupted.
- Errors in `--json` are `{error: {code, message, hint}}`. `OPENSUME_OUTPUT=json` makes every command print JSON without the flag.
- Every command and flag: `opensume --help --json`. Agent skill: https://raw.githubusercontent.com/sumelabs/opensume-cli/main/skills/opensume/SKILL.md
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
