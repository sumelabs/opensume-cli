# AGENTS.md

Notes for coding agents working on this repository. Humans: [CONTRIBUTING.md](CONTRIBUTING.md) says the same things at more length.

## What this is

`opensume` is the command-line client for the Sume Open API, the API behind open.sume.com. It lists models and prices, prices a request, submits it to the image or video router, polls the job, and saves the files. The API contract is the OpenAPI document at `https://api.dev.sume.com/v1/openapi.json`; the docs are at `https://api.dev.sume.com/docs`.

## Commands

```sh
npm ci                 # install dev tools (there are no runtime dependencies)
npm run dev -- <args>  # run from source, e.g. npm run dev -- models --kind video
npm test               # vitest: unit + end-to-end against a mock API, ~1 s
npm run check          # lint + typecheck + test + build; run before you finish
npm run lint:fix       # Biome format and lint fixes
node scripts/build-binaries.mjs darwin-arm64   # standalone binary (needs bun)
```

## Where things are

- `src/cli.ts`: the command tree, global flags, help, error reporting, exit codes.
- `src/commands/*.ts`: one command per file. Each exports a `CommandSpec` with `run(parsed, ctx)`.
- `src/api/client.ts`: every HTTP call. Request ids, retries and the `data`/`error` envelopes live here.
- `src/lib/body.ts`: maps flags onto request fields. Its router rules follow `GET /v1/open/catalog` `kind`: `image` goes to the image router, everything else to the video router.
- `src/lib/wait.ts`, `download.ts`, `upload.ts`: the job lifecycle around a submit.
- `test/helpers/mock-api.ts`: the mock Open API used by `test/cli.test.ts`.

## Rules

- Keep zero runtime dependencies.
- Use erasable TypeScript only (no `enum` or `namespace`), and import local files with `.ts`.
- Send all output through `ctx.ui`: results to stdout, everything else to stderr. Never use `console.*`.
- `--json` prints exactly one JSON document, errors included. Do not break its fields.
- Exit codes in `src/lib/errors.ts` are a public contract. Add new ones; never repurpose old ones.
- Never print or log an API key, or a presigned upload URL.
- Never call the real API in tests. Extend the mock instead.
- A user-visible change gets a line under **Unreleased** in `CHANGELOG.md`, and README updates for new commands or flags.
- Bump the version in both `package.json` and `src/version.ts`.

## Real API checks

With a key in `SUME_API_KEY`, prefer free calls: `opensume models`, `opensume estimate`, `opensume run … --dry-run`. A paid check should be the cheapest model that proves the point (`gpt-image-2 -q low` costs under a cent). Pass `--max-usd` so a mistake cannot spend more.
