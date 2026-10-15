import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { ApiError } from "../api/errors.ts";
import type { Estimate } from "../api/types.ts";
import type { Context } from "../context.ts";
import type { CommandSpec, Parsed } from "../lib/args.ts";
import { buildBody, type InputFlags, localMediaPaths, replaceMedia, routerFor } from "../lib/body.ts";
import { checkTemplate } from "../lib/download.ts";
import { CliError, ExitCode, UsageError } from "../lib/errors.ts";
import { unknownFields } from "../lib/schema.ts";
import { formatBytes, formatUsd } from "../lib/ui.ts";
import { uploadFile } from "../lib/upload.ts";
import {
  followJob,
  INPUT_FLAGS,
  pricingNotes,
  reportJobFailure,
  resolveModel,
  timeoutFlag,
  WAIT_FLAGS,
} from "./shared.ts";

export const run: CommandSpec = {
  name: "run",
  group: "Generate",
  summary: "Generate an image or a video and save it to disk",
  description:
    "Submits a job to the model, waits for it, and saves the result in the current directory (or where -o says). " +
    "Media flags take a public https URL or a local file; local files are uploaded to Sume first. " +
    "Every submit carries an Idempotency-Key, so a retried submit never pays twice.",
  args: [
    {
      name: "model",
      required: true,
      complete: "models",
      description: "A model id from `opensume models`, like gpt-image-2 or seedance-2-mini",
    },
    { name: "prompt", description: "What to make. Quote it." },
  ],
  flags: [
    ...INPUT_FLAGS,
    ...WAIT_FLAGS,
    { name: "no-wait", type: "boolean", section: "Submit", description: "Submit, print the job id and exit" },
    {
      name: "max-usd",
      type: "number",
      placeholder: "<dollars>",
      section: "Submit",
      description: "Refuse to submit if the price is above this",
    },
    {
      name: "dry-run",
      type: "boolean",
      section: "Submit",
      description: "Show the request and its price; submit nothing",
    },
    {
      name: "webhook",
      type: "string",
      placeholder: "<url>",
      section: "Submit",
      description: "Also POST the outcome to this public https URL",
    },
    {
      name: "idempotency-key",
      type: "string",
      placeholder: "<key>",
      section: "Submit",
      description: "Use this Idempotency-Key, not a new UUID; resending it returns the same job",
    },
  ],
  examples: [
    'opensume run gpt-image-2 "a ceramic cup on a wooden table, morning light" -q low',
    'opensume run seedance-2-mini "a paper boat drifting down a rain gutter" -d 4 -r 480p -o boat.mp4',
    'opensume run gpt-image-2 "the same scene at night" --image ./cup.png',
    "opensume run veed-lipsync --video ./talk.mp4 --audio ./line.wav -d 6",
    "opensume run veed-subtitles --video ./clip.mp4 -d 12 --set captions.style=glass",
    'opensume run gpt-image-2 "a red kite" --max-usd 0.05 --json | jq -r ".artifacts[0].path"',
  ],
  run: runCommand,
};

async function runCommand(parsed: Parsed, ctx: Context): Promise<number> {
  const { ui, json } = ctx;
  const flags = parsed.flags as InputFlags & Record<string, unknown>;
  const [modelId, positionalPrompt] = parsed.args as [string, string | undefined];
  if (positionalPrompt !== undefined && flags.prompt !== undefined) {
    throw new UsageError("Give the prompt once: as the second argument or with --prompt, not both.");
  }
  const prompt = positionalPrompt ?? flags.prompt;
  // Every local check happens before anything is uploaded or paid for.
  const timeoutMs = timeoutFlag(flags);
  checkTemplate(flags.output as string | undefined);
  const startedAt = Date.now();
  const client = ctx.client();

  ui.spin(`Looking up ${modelId}`);
  const model = await resolveModel(ctx, modelId);
  const body = await buildBody(model, { ...flags, prompt });
  const localFiles = localMediaPaths(body);
  const maxUsd = flags["max-usd"] as number | undefined;
  const warnings: string[] = [];
  const warn = (note: string) => {
    warnings.push(note);
    if (!json) ui.warn(note);
  };
  for (const note of unknownFields(routerFor(model), body)) warn(note);

  // The estimate prices the request as sent; uploaded files only change
  // their URLs, so placeholders stand in for them until they exist.
  const estimateBody = structuredClone(body);
  replaceMedia(
    estimateBody,
    new Map(localFiles.map((p) => [p, `https://upload.invalid/${encodeURIComponent(basename(p))}`])),
  );
  const estimating: Promise<{ estimate?: Estimate; error?: unknown }> = client
    .estimate(model.id, estimateBody, ctx.signal)
    .then(
      (estimate) => ({ estimate }),
      (error: unknown) => {
        ui.debug(`estimate failed: ${(error as Error).message}`);
        return { error };
      },
    );

  if (flags["dry-run"] === true) {
    const { estimate } = await estimating;
    ui.stopSpinner();
    const notes = [...warnings, ...(estimate ? pricingNotes(body, estimate) : [])];
    if (json) {
      ui.json({
        model: model.id,
        router: routerFor(model),
        body,
        uploads: localFiles,
        estimate: estimate ?? null,
        ...(notes.length ? { warnings: notes } : {}),
      });
    } else {
      ui.out(`${ui.c.dim(`POST /v1/${routerFor(model)}-router/generate`)}`);
      ui.out(JSON.stringify({ ...body, model: model.id }, null, 2));
      if (localFiles.length) ui.info(ui.c.dim(`Would upload: ${localFiles.join(", ")}`));
      ui.info(estimate ? `Price: ${priceLine(estimate)}` : "Price: unavailable");
      for (const note of notes.slice(warnings.length)) ui.warn(note);
    }
    return ExitCode.Ok;
  }

  if (maxUsd !== undefined) {
    const { estimate, error } = await estimating;
    if (!estimate) throw unpriced(error);
    for (const note of pricingNotes(body, estimate)) warn(note);
    if (Number(estimate.usd) > maxUsd) {
      throw new CliError(
        `This costs ${formatUsd(estimate.usd)}, over --max-usd ${formatUsd(maxUsd)}. Nothing was submitted.`,
        { exitCode: ExitCode.Funds, code: "over_budget" },
      );
    }
  }

  if (localFiles.length > 0) {
    const urls = new Map<string, string>();
    for (const path of localFiles) {
      ui.spin(`Uploading ${basename(path)}`);
      const uploaded = await uploadFile(client, resolve(ctx.cwd, path), { signal: ctx.signal });
      urls.set(path, uploaded.url);
      ui.info(`${ui.c.dim("↑")} ${basename(path)} ${ui.c.dim(`${formatBytes(uploaded.sizeBytes)} uploaded`)}`);
    }
    replaceMedia(body, urls);
  }

  const idempotencyKey = (flags["idempotency-key"] as string | undefined) ?? randomUUID();
  // From here on, any error or interrupt names the key (and then the job),
  // so a retry adopts the job instead of paying for a second one.
  ctx.idempotencyKey = idempotencyKey;
  ui.spin(`Submitting to ${model.id}`);
  let submitted: Awaited<ReturnType<typeof client.generate>>;
  try {
    submitted = await client.generate(routerFor(model), { ...body, model: model.id }, idempotencyKey, ctx.signal);
  } catch (error) {
    // The provider can refuse a job the moment it is submitted: the API then
    // answers with the job already failed. That is a failed job (exit 5), not
    // a broken request, and it is refunded.
    const failed = error instanceof ApiError ? error.failedJob() : undefined;
    if (!failed) throw error;
    ui.stopSpinner();
    ctx.jobId = failed.id;
    return reportJobFailure(ctx, {
      jobId: failed.id,
      model: failed.model ?? model.id,
      state: failed.status,
      error: failed.error ?? { message: error instanceof Error ? error.message : String(error) },
      extra: { idempotency_key: idempotencyKey },
    });
  }
  const job = submitted.data.job;
  ctx.jobId = job.id;
  const { estimate } = await estimating;
  ui.stopSpinner();
  if (submitted.data.idempotency_hit) ui.info(ui.c.dim(`Idempotency key matched ${job.id}; following that job.`));

  if (flags["no-wait"] === true) {
    if (json) {
      ui.json({ ...submitted.data, ...(estimate ? { estimate } : {}), ...(warnings.length ? { warnings } : {}) });
    } else {
      ui.success(`Submitted ${ui.c.bold(job.id)} (${model.id}${estimate ? `, ${formatUsd(estimate.usd)}` : ""})`);
      ui.info(ui.c.dim(`Follow it with: opensume jobs wait ${job.id}`));
      if (!ui.options.stdout.isTTY || ui.options.quiet) ui.out(job.id);
    }
    return ExitCode.Ok;
  }

  ui.info(ui.c.dim(`Job ${job.id}`));
  return followJob(ctx, {
    jobId: job.id,
    model: model.id,
    startedAt,
    timeoutMs,
    firstDelaySeconds: submitted.data.terminal ? 0 : submitted.data.next_poll_after_seconds,
    flags,
    usd: estimate?.usd,
    replayed: submitted.data.idempotency_hit,
    extra: {
      idempotency_key: idempotencyKey,
      ...(submitted.data.idempotency_hit ? { idempotency_hit: true } : {}),
      ...(warnings.length ? { warnings } : {}),
    },
  });
}

/** Why `--max-usd` could not be checked, with the API's own reason when it gave one. */
function unpriced(error: unknown): CliError {
  if (error instanceof ApiError) {
    return new CliError(
      `Could not price the request (${error.message}), so --max-usd cannot be checked. Nothing was submitted.`,
      {
        exitCode: error.exitCode,
        code: error.apiCode,
        hint: error.requestId ? `Request id: ${error.requestId}` : error.hint,
      },
    );
  }
  return new CliError("Could not price the request, so --max-usd cannot be checked. Nothing was submitted.", {
    code: "estimate_unavailable",
    hint: error instanceof Error ? error.message : undefined,
  });
}

export function priceLine(estimate: Estimate): string {
  const billing = estimate.billing;
  const basis: string[] = [];
  if (billing?.duration_seconds) basis.push(`${billing.duration_seconds}s`);
  if (billing?.resolution) basis.push(billing.resolution);
  return `${formatUsd(estimate.usd)}${basis.length ? ` (${basis.join(", ")})` : ""}`;
}
