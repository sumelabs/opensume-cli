---
name: opensume
description: Generate images, video, lip-sync and captions with the Sume Open API through the `opensume` CLI. Use when the user asks to make or edit an image or a video clip, lip-sync a face to speech, burn captions into a video, compare media models or their prices, or check on a Sume generation job.
---

# opensume

`opensume` runs any model on open.sume.com from the shell: it prices a request, submits it, waits for the job, and saves the file. Every command prints one JSON document with `--json`.

## Before you start

- Check the key: `opensume auth status --json`. If `valid` is false, read `error.hint` first: a key works only on the API host it was made for, so a good key on the wrong host looks wrong. The default host is Open production (`https://api.open.sume.com`); keys from open.sume.com are for `https://api.dev.sume.com` while it is in preview, and `SUME_API_BASE_URL` picks the host. Otherwise ask the user to create a key at https://open.sume.com/api-keys and export it as `SUME_API_KEY`. Never ask them to paste it into the chat, and never print it.
- Generation costs real money from the user's open.sume.com balance. Pricing (`estimate`) and listing (`models`) are free.

## Pick a model

```sh
opensume models --json                      # every model: id, kind, pricing, modes, capabilities
opensume models --kind video --json         # kinds: image, video, lipsync, captions
opensume models seedance-2-mini --json      # one model: inputs, limits, price options, notes
```

Read a model's `capabilities` and `constraints` before building a request: they list the allowed resolutions, durations, aspect ratios and required inputs. `opensume schema <model> --json` lists every request field with its type, limits and the flag that sets it; fields without a flag go through `--set field=value`.

Check the setup first when something fails: `opensume doctor --json` checks the key, the API host and the media host.

## Price it, then run it

```sh
opensume estimate seedance-2-mini "a paper boat drifting" -d 4 -r 480p --json   # {"usd": "0.3516", …}
opensume run seedance-2-mini "a paper boat drifting" -d 4 -r 480p --max-usd 0.50 -o boat.mp4 --json
```

- Always pass `--max-usd`, set to what the user agreed to spend. Over the limit, the command exits 7 and submits nothing.
- For a large or unusual spend, tell the user the estimate and wait for a yes.
- `run --json` prints `{"job": {...}, "usd": "...", "artifacts": [{"path": "...", "url": "...", "content_type": "..."}]}`. The files are already saved at `path`.
- Local files work wherever a URL does (`--image ./photo.png`, `--video ./clip.mp4`, `--audio ./line.wav`). They are uploaded first.
- Fields without their own flag go through `--set key=value`, for example `--set captions.style=glass`.

## Long jobs

Video can take minutes. To avoid blocking:

```sh
opensume run kling-3 "…" -d 5 --no-wait --json        # returns {"job": {"id": "job_…"}, …} at once
opensume jobs wait job_… -o ./out/ --json              # later: waits and saves
```

`--logs --json` adds the job's events to the result; `opensume jobs events <id> --follow --json` prints them as JSON lines while the job runs. Job ids can be shortened to their first 8 characters.

If a wait times out (exit 6) or is interrupted (exit 130), the job keeps running. Resume it with `opensume jobs wait <id>`; the error names the job. Do not resubmit: a second submit is a second charge. If the submit itself failed, the error carries `idempotency_key`; pass it back with `--idempotency-key` to adopt the job if it was created.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | |
| 1 | Network or server error | Retry; for a failed submit, pass back its `idempotency_key` |
| 2 | Bad command line | Fix the flags; see `opensume <command> --help` |
| 3 | Key missing, wrong, for the other host, or not allowed | Follow `error.hint`; else ask the user for a valid key |
| 4 | The API refused the request | Read `error.message` and `error.details`, fix the input |
| 5 | The job failed or was canceled | `opensume jobs get <id> --json` has the `error`; failed jobs are refunded |
| 6 | Timed out waiting | `opensume jobs wait <id>` |
| 7 | Balance too low, or over `--max-usd` | Tell the user |
| 8 | Rate limit or concurrency cap | Wait for running jobs, then retry |
| 130 | Interrupted | `opensume jobs wait <id>` with the id the error names |

With `--json`, errors are `{"error": {"code", "message", "hint", "status", "request_id"}}`. Quote `request_id` when the user needs support.
