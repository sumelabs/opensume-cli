<h1 align="center">opensume</h1>

<p align="center">
  Images and video from your terminal, on the <a href="https://open.sume.com">Sume Open API</a>.
</p>

<p align="center">
  <a href="https://github.com/sumelabs/opensume-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sumelabs/opensume-cli/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/sumelabs/opensume-cli/releases"><img alt="Release" src="https://img.shields.io/github/v/release/sumelabs/opensume-cli?sort=semver"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-%E2%89%A522-339933">
</p>

<p align="center">
  <img src="docs/demo.gif" alt="opensume listing OpenAI models, generating a cup image with gpt-image-2, then turning it into a video with grok-imagine-video-1.5" width="820">
  <br><sub>A real session against the API, played at 1.5×.</sub>
</p>

`opensume` runs any model on [open.sume.com](https://open.sume.com) from one command. It covers image, video, lip-sync and captions. It shows the price in dollars before you spend, submits the job, waits for it, and saves the file next to you. The same command works for a person at a terminal and for a script or an AI agent: add `--json` and every command prints one JSON document.

- **Prompt to file in one command.** `opensume run <model> "<prompt>"` submits, polls and downloads.
- **Every open.sume.com model behind one key.** Images, video, lip-sync and captions, with prices from `opensume models`.
- **Know the price first.** `opensume estimate` is free and needs no key. `--max-usd` refuses anything over budget.
- **Local files just work.** Pass `--image ./photo.png`; it is uploaded for you.
- **Safe to retry.** Submits carry an idempotency key, the CLI's own retries reuse it, and an error after a submit names the key or the job, so a retry never pays twice.
- **Made for scripts and agents.** `opensume agent` prints the whole setup on one page for an agent to follow. `--json` everywhere, documented exit codes, a machine-readable command list, and an [agent skill](skills/opensume/SKILL.md).
- **Every field is a flag.** Anything a model's endpoint takes can be passed by name: `--rendering_speed fast`, `--captions.style glass`.
- **One self-contained binary.** No runtime to install, no dependencies, no telemetry, no background update checks.

> [!NOTE]
> The CLI calls Open's production API, `https://api.open.sume.com`, with keys from [open.sume.com](https://open.sume.com/api-keys). `https://api.sume.com` is sume.com's API, not Open's; see [API hosts](#api-hosts). The [API docs](https://open.sume.com/docs) are on open.sume.com.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Prices and spending](#prices-and-spending)
- [Scripts and agents](#scripts-and-agents)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Contributing](#contributing)

## Install

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.ps1 | iex
```

Both scripts download the binary for your platform from the [latest release](https://github.com/sumelabs/opensume-cli/releases/latest), check it against the release's SHA-256 checksums, and put it on your `PATH` (`~/.opensume/bin`, or `%LOCALAPPDATA%\opensume\bin` on Windows). Builds exist for macOS (Apple silicon and Intel), Linux (x64 and arm64, glibc and musl) and Windows x64. On Alpine, install the C++ runtime first: `apk add libstdc++ libgcc`. Set `OPENSUME_VERSION=0.1.0` to pin a version, `OPENSUME_INSTALL_DIR` to choose the folder, or `OPENSUME_NO_MODIFY_PATH=1` to leave your `PATH` alone.

**With Node.js 22 or newer**

```sh
npm install -g https://github.com/sumelabs/opensume-cli/releases/latest/download/opensume.tgz
```

**From source**

```sh
git clone https://github.com/sumelabs/opensume-cli.git && cd opensume-cli
npm ci && npm run build && npm link
```

Check it with `opensume --version`.

## Quick start

**For a coding agent** the whole path is three commands, with no setup step in between:

```sh
curl -fsSL https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.sh | sh  # on PATH in this same shell
opensume init                                                       # AGENTS.md + Claude skill (+ Cursor rule)
opensume run gpt-image-2 "a red kite over a beach" -q low -o out/   # prints the saved file's path
```

The key comes from `SUME_API_KEY` or `./.env`; a person makes it at open.sume.com → API keys. The host needs nothing. `opensume agent` prints the page `init` writes, followed by every model with its price per image or second.

**1. Get a key.** Sign in at [open.sume.com](https://open.sume.com), open **API keys**, and create one. Then save it:

```sh
opensume auth login        # paste the key; it is checked, then stored for your user only
```

Or export it for the current shell instead: `export SUME_API_KEY="sume_live_..."`.

**2. Make an image.** This one costs under a cent:

```console
$ opensume run gpt-image-2 "a ceramic cup on a wooden table, morning light" -q low -o cup.png
Job job_7558248a-3a25-4b2a-9f6a-832bdc23b846
✓ gpt-image-2 completed in 15s · $0.0060
  cup.png  934 KB · image/png
```

**3. Turn it into a video.** The local file is uploaded first. This one costs $0.05:

```console
$ opensume run grok-imagine-video-1.5 "slow push in, steam rising" --image cup.png -d 4 -r 480p
↑ cup.png 934 KB uploaded
Job job_90f64f18-cd22-4ab3-8fc3-2a241a8678a5
✓ grok-imagine-video-1.5 completed in 26s · $0.0500
  grok-imagine-video-1.5-90f64f18.mp4  957 KB · video/mp4
```

<table>
  <tr>
    <td align="center"><img src="docs/cup.jpg" width="256" alt="A ceramic cup on a wooden table in morning light"><br><sub><code>cup.png</code> · gpt-image-2</sub></td>
    <td align="center"><img src="docs/cup-video.gif" width="256" alt="The same cup with steam rising, camera pushing in"><br><sub><code>grok-imagine-video-1.5-90f64f18.mp4</code></sub></td>
  </tr>
</table>

**4. Explore.** `opensume models` lists every model with its starting price, and `opensume models <id>` shows what a model takes:

```console
$ opensume models seedance-2-mini
seedance-2-mini — Seedance 2.0 Mini (ByteDance)
Generates video from text, an image, references · 480p to 720p · 4–15 s · native audio

Kind           video
Modes          text-to-video, image-to-video, reference-to-video
Price          from $0.0879/s
               480p  $0.0879/s
               720p  $0.1890/s
Takes          text to video, image to video, end frame, reference images, reference videos,
               reference audio, audio
Resolutions    480p, 720p
Duration       4–15 s
Aspect ratios  auto, adaptive, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16

Try it
  $ opensume run seedance-2-mini "a paper boat drifting down a rain gutter" -d 4 -r 480p
```

## Commands

| Command | What it does |
|---|---|
| [`run`](#run) | Generate an image or a video and save it |
| [`estimate`](#estimate) | Price a request in dollars, free, with no key |
| [`upload`](#upload) | Upload local files, or copy URLs, to Sume storage |
| [`models`](#models) | List models and prices, or show one |
| [`schema`](#schema) | Every input a model takes: type, limits, choices, flag |
| [`jobs`](#jobs) | List, wait for, inspect, follow and cancel jobs |
| [`agent`](#agent) | One page for an agent: setup, how to run, every model and its price |
| [`init`](#agent) | Write that page into the project: AGENTS.md, a Claude skill, a Cursor rule |
| [`auth`](#auth) | Save, check or forget your key |
| [`doctor`](#doctor) | Check the install, the key and the connection |
| `completion` | Shell completion for bash, zsh and fish |
| `update` | Update a standalone install to the latest release |
| `version` | Print the version |

Every command has `--help`. Global flags work anywhere: `--json`, `--quiet`, `--verbose` (each API call with its request id), `--no-color`, `--api-key` and `--base-url`.

### run

```sh
opensume run <model> [prompt] [flags]
```

`run` picks the right endpoint for the model, uploads any local files, submits with an idempotency key, waits, and saves the result. Without `-o`, files land in the current directory as `<model>-<job>.<ext>` and never overwrite anything.

```sh
# Edit an image with a reference
opensume run gpt-image-2 "the same cup, at night by candlelight" --image cup.png -q medium

# Video from text, with a budget
opensume run seedance-2-mini "a paper boat drifting down a rain gutter" -d 4 -r 480p --max-usd 0.50

# Lip-sync a clip to speech
opensume run veed-lipsync --video talk.mp4 --audio line.wav -d 6

# Burn captions into a clip (every field is a flag; dots reach nested ones)
opensume run veed-subtitles --video clip.mp4 -d 12 --captions.style glass

# Submit now, collect later (a job id's first 8 characters are enough)
opensume run kling-3 "a red kite over a beach" -d 5 --no-wait
opensume jobs wait 7513b52d

# Watch the job's events as they happen, and name the files yourself
opensume run seedance-2-mini "a paper boat" -d 4 --logs -o "out/{model}-{job}.{ext}"
```

| Flags | |
|---|---|
| **Inputs** | `-p, --prompt` · `-i, --image` (repeatable) · `--end-image` · `--video` · `--audio` · `--ref-image`, `--ref-video`, `--ref-audio` (repeatable) · `--mask`. Each takes a public https URL or a local file. |
| **Settings** | `-a, --aspect-ratio` · `-r, --resolution` · `-d, --duration` · `-q, --quality` · `-n, --num-images` · `--format` · `--size` · `--background` · `--[no-]generate-audio` · `--<field> <value>` for any other field in `opensume schema <model>` (`--rendering_speed fast`, `--captions.style glass`, `--no-<field>` for false) · `--set key=value` does the same (JSON values, `a.b` nesting, `key[]=` to append) · `--input body.json` (or `-` for stdin) |
| **Output** | `-o, --output <file, dir/ or template>` · `--logs` (stream the job's events) · `--no-download` (print URLs) · `--all-files` (also save intermediate files, like a video's poster frame) · `--timeout 20m` · `--open` |
| **Submit** | `--max-usd <dollars>` · `--dry-run` (print the request and price) · `--no-wait` · `--webhook <url>` · `--idempotency-key <key>` |

A flag that a model's endpoint does not take is refused before anything is sent: `--duration` on an image model, for example. A `--<field>` flag the endpoint does not have is refused with the closest name (`--renderng_speed` → `--rendering_speed`); a `--set` field gets a warning with a suggestion (`qualty` → `quality`). Values follow the field's type, so `--prompt 1984` stays text and `--num_images 2` is a number. Ctrl-C stops waiting, not the job: the CLI prints the job id, and `opensume jobs wait <id>` picks it up later.

`-o` takes a file name, a directory (ending in `/`), or a template with `{model}`, `{job}` (8 characters), `{job_id}`, `{index}`, `{ext}` and `{type}`. Named files and templates overwrite; the default names never do.

### estimate

```console
$ opensume estimate seedance-2-mini "a paper boat" -d 4 -r 480p
$0.3516  seedance-2-mini · 4s · 480p · 40.176 × 1000 video tokens
```

`estimate` takes the same input flags as `run` and submits nothing. Local files are not uploaded to price a request. If the API prices something other than what you asked for, `estimate` says so. A 99-second request on a 15-second model, for example, is priced as 15 seconds.

### upload

```sh
opensume upload photo.png clip.mp4                 # prints one media URL per file
opensume upload https://example.com/shared/a.mp4   # copies a remote file in, for links that expire
```

### models

```sh
opensume models                         # every model, with its starting price
opensume models --kind video            # image, video, lipsync or captions
opensume models --company google
opensume models seedance                # filter by any word
opensume models veed-subtitles          # one model: inputs, limits, prices, notes
opensume models --brief                 # one line each: price per image or second, inputs, limits; cheapest first
```

`--brief --json` is the short list for an agent choosing a model: about 12 KB for the whole catalog instead of 85 KB.

### schema

```console
$ opensume schema veed-subtitles
veed-subtitles — inputs for POST /v1/video-router/generate

FIELD                       TYPE                           FLAG
video_url                   url                            --video
    Source clip for video-to-video models.
captions                    object                         --set
    Caption models only (veed-subtitles): burns styled lines into video_url.
  captions.style *          string                         --set
      The caption style (see the model's catalog constraints).
duration                    integer 2–600                  -d, --duration
…
```

`schema` lists every field of the model's endpoint with its type, limits, choices and the flag that sets it; `--full` prints whole descriptions and `--json` the schema itself. `opensume run <model> --help` ends with the same table. The schema ships inside the CLI (taken from the API's OpenAPI document at release), so it works offline.

### jobs

```sh
opensume jobs list [--status processing] [--limit 50]
opensume jobs get <id>              # input, timing, error, files
opensume jobs status <id>           # one status read
opensume jobs wait <id> [-o dir/]   # wait for it, then save its files
opensume jobs events <id> [--follow]   # the job's timeline; --follow tails it until it ends
opensume jobs cancel <id>           # only before generation starts; refunded
```

`<id>` is a full job id or a unique start of one, such as the 8 characters in a file name (`gpt-image-2-0ae33f04.png` → `0ae33f04`).

### agent

```sh
opensume init                       # write the page into AGENTS.md and .claude/skills/opensume/SKILL.md (+ .cursor/rules if .cursor/ exists)
opensume agent                      # print the page, what this machine uses, and every model with its price
opensume agent --json               # the same as fields: install, default_base_url, key.set, models[], …
opensume agent --write CLAUDE.md    # the page as a marked block in any one file
```

The page is what an agent needs and nothing else: the install line, where the key comes from (`SUME_API_KEY` or `./.env`), the host (`https://api.open.sume.com`, nothing to set) and the one to avoid (`https://api.sume.com`), three commands that make a file, the spend cap, and what each exit code means. `init` and `--write` keep it between markers, so running them again refreshes the page and leaves the rest of the file alone; `init` makes no network calls. `agent` adds the live model list from the public catalog (no key).

### auth

```sh
opensume auth login                                  # prompts, hidden
printenv SUME_API_KEY | opensume auth login --with-key   # from stdin
opensume auth status                                 # which key and host, and whether the key works
opensume auth logout                                 # forget the saved key
```

### doctor

```console
$ opensume doctor
✓ CLI     opensume 0.4.3 (bun 1.4.2, darwin arm64, standalone)
✓ Update  latest release
✓ Config  ~/.config/opensume/config.json (mode 600)
✓ API     https://api.open.sume.com · ok · build 5fadc7571 (open-v0.2.0) · public · 197ms
✓ Models  52 models in the open catalog · 117ms
✓ Key     sume_live_Xy12_ab3…9QzK (SUME_API_KEY) · accepted · 120ms
✓ Media   media.sume.com reachable · 97ms
```

`doctor` exits non-zero when a check fails (3 for the key), and `--json` returns every check. It spends nothing.

## Prices and spending

open.sume.com keys pay in US dollars from your open.sume.com balance; top up under **Billing**.

- **Before you submit:** `opensume estimate` and `opensume run --dry-run` show the price for free. The estimate is what a completed job is charged.
- **When you submit:** the price is reserved. With `--max-usd` (or `OPENSUME_MAX_USD` in the environment, for every run), the CLI checks the estimate first and submits nothing if the price is higher (exit code 7).
- **When the job ends:** a completed job is charged; a failed or canceled job is refunded.
- **Retries never double-charge:** every submit carries an `Idempotency-Key`, and a retried submit returns the original job. If the CLI gives up on a submit, the error prints the key (`idempotency_key` in `--json`); rerun with `--idempotency-key <key>` to adopt the job rather than create another.

## Scripts and agents

**From code**, the same API has official clients: [`sume`](https://github.com/sumelabs/sume-python) for Python (`sume.run("gpt-image-2", "a kite", quality="low").save("kite.png")`) and [`@sume-com/open`](https://github.com/sumelabs/sume-js) for JavaScript and TypeScript on the server.


**`--json`** prints exactly one JSON document on stdout for every command, errors included, and nothing on stderr. Abridged:

```console
$ opensume run gpt-image-2 "a red kite over a beach, flat illustration" -q low -o kite.png --max-usd 0.02 --json
{
  "job": { "id": "job_d45000cc-9bc7-4631-8feb-18e596a6da3d", "model": "gpt-image-2", "status": "completed" },
  "usd": "0.0060",
  "elapsed_ms": 15093,
  "artifacts": [
    {
      "id": "artf_oaWANFBUVhkFz_urjAHjBw21wn_qb_Ya",
      "type": "image",
      "url": "https://media.sume.com/artifacts/artf_oaWANFBUVhkFz_urjAHjBw21wn_qb_Ya/images.png",
      "content_type": "image/png",
      "path": "/home/you/kite.png",
      "bytes": 618337
    }
  ],
  "idempotency_key": "05614b0e-04ac-4c56-84d6-6d303e8744d4"
}
```

Without `--json`, results go to stdout and everything else (progress, notes, errors) to stderr, so `opensume run … | xargs open` gets just the file paths.

**`OPENSUME_OUTPUT=json`** makes every command print JSON as if it had `--json`, for an agent harness that cannot add a flag. `OPENSUME_OUTPUT=auto` does so only when stdout is not a terminal. Completion scripts stay shell code either way.

**Exit codes** are stable:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Unexpected error, network failure, server error |
| `2` | Bad command line: unknown flag, missing argument |
| `3` | No key, wrong or revoked key, or a route the key may not call |
| `4` | The API refused the request: invalid input, unknown model or job |
| `5` | The job failed or was canceled (`opensume jobs get <id>` says why; it is refunded) |
| `6` | `--timeout` passed while the job was still running |
| `7` | Balance too low, or the price is over `--max-usd` |
| `8` | Rate limit or concurrency cap; retry later |
| `130` | Stopped by Ctrl-C, SIGTERM or SIGHUP (the job keeps running; the error names it) |

**The whole command tree as JSON:** `opensume --help --json`. It is generated from the same definitions as `--help`, so it never drifts. `opensume schema <model> --json` gives a model's inputs the same way.

**Events:** `run --logs --json` adds the job's events to the document; `opensume jobs events <id> --follow --json` prints one JSON event per line until the job ends.

**Agent skill.** [`skills/opensume/SKILL.md`](skills/opensume/SKILL.md) teaches coding agents (Claude Code and others that read skills) to pick a model, check the price, cap the spend and handle long jobs. Copy it into your agent's skills folder:

```sh
mkdir -p ~/.claude/skills/opensume
curl -fsSL https://raw.githubusercontent.com/sumelabs/opensume-cli/main/skills/opensume/SKILL.md -o ~/.claude/skills/opensume/SKILL.md
```

## Configuration

| Setting | Flag | Environment | Saved in config |
|---|---|---|---|
| API key | `--api-key` | `SUME_API_KEY`, or that line in `./.env` | `opensume auth login` |
| API host | `--base-url` | `SUME_API_BASE_URL` | `opensume auth login --base-url …` |
| Output | `--json` | `OPENSUME_OUTPUT=json` (or `auto`) | |
| Spend cap per run | `--max-usd` | `OPENSUME_MAX_USD` | |

A flag beats the environment, which beats `./.env`, which beats the config file. From `./.env` the CLI reads `SUME_API_KEY` and nothing else: the API host never comes from a project file, so a cloned repo cannot send your saved key elsewhere. The config file is `~/.config/opensume/config.json` (`$XDG_CONFIG_HOME` is honored, `%APPDATA%\opensume` on Windows, or `$OPENSUME_CONFIG_DIR`). It is created readable by your user only. The key in it is not encrypted, so treat it like an SSH key, or use `SUME_API_KEY` instead.

Color follows the terminal; `NO_COLOR=1` or `--no-color` turns it off and `FORCE_COLOR=1` turns it on. Completion caches model ids for a day under `~/.cache/opensume`.

### API hosts

| Host | What it is | Keys |
|---|---|---|
| `https://api.open.sume.com` (default) | Open's production API, released as `open-v*` tags | [open.sume.com → API keys](https://open.sume.com/api-keys) |
| `https://open-api-development.up.railway.app` | Open's development API: every new commit, same models | open.dev.sume.com (Sume staff) |
| `https://api.sume.com` | **Not Open.** sume.com's own API | Open keys do not work there |

A key works only on the host it was made for. On another host it is refused like a wrong key, and the error names the other host to try. `opensume doctor` shows which host and release you are on, and fails on `api.sume.com`.

**Shell completion** (commands, flags and model ids):

```sh
eval "$(opensume completion bash)"     # in ~/.bashrc
eval "$(opensume completion zsh)"      # in ~/.zshrc
opensume completion fish > ~/.config/fish/completions/opensume.fish
```

## How it works

```text
opensume run  ──▶  POST /v1/{image,video}-router/generate   202 + job id, with an Idempotency-Key
              ──▶  GET  /v1/jobs/{id}/status                until terminal
              ──▶  GET  /v1/jobs/{id}/result                artifacts on media.sume.com
              ──▶  download each file                        through a .part file, then renamed
```

- **Picking the endpoint.** The model's `kind` in the open catalog decides it. Image models go to the image router; video, lip-sync and captions go to the video router.
- **Polling.** The CLI follows the API's `next_poll_after_seconds`, capped at 5 s for the first minute of waiting, 10 s up to ten minutes, and 15 s after that, so a job that finishes early is noticed early. Transient errors (network, 429, 5xx) are retried and do not end the wait. If several reads in a row fail, the CLI says it lost contact, keeps trying, and says when it is back.
- **Retries.** Reads, submits that carry an idempotency key, upload targets and the upload itself are retried with backoff, honoring `retry-after`. A connection that drops halfway through an answer counts as a network error. When retries run out, the error says how many tries there were. A proxy's HTML error page is reported by its status, like `502 Bad Gateway`, with a pointer to https://status.sume.com.
- **Files.** By default the CLI saves a job's final outputs. Intermediate files, like a video's poster frame, are listed in `--json` and saved only with `--all-files`.
- **Saving safely.** Each file is written to a `.part` file and gets its name only when it is complete. Before that, the CLI checks the size against `Content-Length` and against the job's declared size and checksum when it has them. An empty body or a web page in place of an image is refused and retried. A full or read-only disk is reported at once rather than retried.
- **Partial saves.** One file that cannot be saved does not stop the others. The command exits 1, names the missing files and prints the command that gets them. A file already saved under the job's default name is complete, so `opensume jobs wait <id>` skips it and fetches only what is missing.
- **Checked before paying.** `run` checks everything it can on this machine before it submits: that `-o` can be written (or that the current folder can, without `-o`), that every local file exists and has a media type, the key, the webhook URL, the idempotency key, and number ranges. An empty value, such as `--image "$UNSET"`, is refused rather than dropped.
- **Signals.** Ctrl-C, SIGTERM and SIGHUP stop the wait, not the job. The CLI exits 130 with an error that names the job (`job_id` in `--json`), so a harness that kills a slow run can still collect it with `opensume jobs wait`.

## Troubleshooting

| You see | What to do |
|---|---|
| `No API key` (exit 3) | `opensume auth login`, or export `SUME_API_KEY`. |
| `Missing or invalid API key` (exit 3) | The key is wrong, revoked, or made for the other [API host](#api-hosts). The error names the host to try; otherwise create a new key at open.sume.com → API keys. |
| `The API key contains spaces, line breaks…` (exit 3) | The key was pasted with extra characters. Copy it again. |
| `open_key_route_not_allowed` (exit 3) | open.sume.com keys call images, video, jobs and prices only. |
| `Balance too low` (exit 7) | Top up at open.sume.com → Billing. The error shows the price and your balance. |
| `concurrency_limit_reached` (exit 8) | Your workspace has as many jobs in flight as it may. Wait for one to finish. |
| `Stopped waiting after …` (exit 6) | The job is still running. `opensume jobs wait <id>` collects it later; do not resubmit. |
| `Saved 1 of 2 files. Could not download …` (exit 1) | The job finished and was paid for; one file did not arrive. Run the command the error prints (`opensume jobs wait <id>`); it fetches only the missing files. |
| `Cannot save files to …` (exit 2) | `-o` (or the current folder) cannot be written. Nothing was submitted. Pick another folder, or pass `--no-download` to print URLs. |
| `--image is empty` (exit 2) | A flag got an empty value, usually from a shell variable that is not set. |
| `Lost contact with the API` | Status reads are failing. The CLI keeps trying until `--timeout`; the job keeps running. See https://status.sume.com. |
| Anything else | Run `opensume doctor`, then re-run with `--verbose` and quote the request id (`req_…`) when you ask for help. |

## Uninstall

```sh
rm -rf ~/.opensume ~/.config/opensume ~/.cache/opensume   # binary, saved key, completion cache
```

Then remove the two lines the installer added to your shell profile (`# opensume` and the `export PATH=…` under it), or `~/.config/fish/conf.d/opensume.fish` for fish. On Windows, delete `%LOCALAPPDATA%\opensume` and `%APPDATA%\opensume`, and remove the folder from your user `PATH`. If you installed with npm: `npm uninstall -g opensume`.

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, tests and releases. Security problems go through [SECURITY.md](SECURITY.md), not public issues. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Sume Labs
