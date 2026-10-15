import { spawn } from "node:child_process";
import { relative } from "node:path";
import { ApiError } from "../api/errors.ts";
import type { Artifact, CatalogModel, Estimate, Job, ResultResponse, StatusResponse } from "../api/types.ts";
import type { Context } from "../context.ts";
import { closest, type FlagSpec } from "../lib/args.ts";
import { downloadTo, planPaths, type SavedFile } from "../lib/download.ts";
import { CliError, ExitCode } from "../lib/errors.ts";
import { formatBytes, formatDuration, formatUsd } from "../lib/ui.ts";
import { parseDuration, waitForJob } from "../lib/wait.ts";

// Flags shared by the commands that build a request (`run`, `estimate`).
export const INPUT_FLAGS: readonly FlagSpec[] = [
  {
    name: "prompt",
    short: "p",
    type: "string",
    placeholder: "<text>",
    section: "Inputs",
    description: "The prompt, instead of the second argument",
  },
  {
    name: "image",
    short: "i",
    type: "string",
    multiple: true,
    placeholder: "<url|file>",
    section: "Inputs",
    description: "Image to edit or follow (image models), or the first frame (video models)",
  },
  {
    name: "end-image",
    type: "string",
    placeholder: "<url|file>",
    section: "Inputs",
    description: "Last frame, for video models",
  },
  {
    name: "video",
    type: "string",
    placeholder: "<url|file>",
    section: "Inputs",
    description: "Source clip, for video-to-video, lip-sync and captions",
  },
  {
    name: "audio",
    type: "string",
    placeholder: "<url|file>",
    section: "Inputs",
    description: "Speech, for lip-sync models",
  },
  {
    name: "ref-image",
    type: "string",
    multiple: true,
    placeholder: "<url|file>",
    section: "Inputs",
    description: "Reference image, for video models",
  },
  {
    name: "ref-video",
    type: "string",
    multiple: true,
    placeholder: "<url|file>",
    section: "Inputs",
    description: "Reference clip, for video models",
  },
  {
    name: "ref-audio",
    type: "string",
    multiple: true,
    placeholder: "<url|file>",
    section: "Inputs",
    description: "Reference audio, for video models",
  },
  {
    name: "mask",
    type: "string",
    placeholder: "<url|file>",
    section: "Inputs",
    description: "Edit mask, for image models",
  },
  {
    name: "aspect-ratio",
    short: "a",
    type: "string",
    placeholder: "<ratio>",
    section: "Settings",
    description: "Aspect ratio, like 16:9 or 9:16",
  },
  {
    name: "resolution",
    short: "r",
    type: "string",
    placeholder: "<res>",
    section: "Settings",
    description: "Resolution, like 480p, 720p or 2K",
  },
  {
    name: "duration",
    short: "d",
    type: "number",
    placeholder: "<seconds>",
    section: "Settings",
    description: "Length in whole seconds (video, lip-sync, captions)",
  },
  {
    name: "quality",
    short: "q",
    type: "string",
    placeholder: "<level>",
    section: "Settings",
    description: "Quality, like low, medium or high (image)",
  },
  {
    name: "num-images",
    short: "n",
    type: "number",
    placeholder: "<n>",
    section: "Settings",
    description: "How many images, 1–4",
  },
  {
    name: "format",
    type: "string",
    placeholder: "<ext>",
    section: "Settings",
    description: "Image format: png, jpeg or webp",
  },
  {
    name: "size",
    type: "string",
    placeholder: "<WxH|preset>",
    section: "Settings",
    description: "Image size, like 1024x1536 or square_hd",
  },
  {
    name: "background",
    type: "string",
    placeholder: "<mode>",
    section: "Settings",
    description: "auto, transparent or opaque (GPT Image 2.5)",
  },
  {
    name: "generate-audio",
    type: "boolean",
    section: "Settings",
    description: "Ask a video model for sound; --no-generate-audio for silence",
  },
  {
    name: "set",
    type: "string",
    multiple: true,
    placeholder: "<key=value>",
    section: "Settings",
    description: "Any other request field, JSON-parsed when it can be: captions.style=glass",
  },
  {
    name: "input",
    type: "string",
    placeholder: "<file|->",
    section: "Settings",
    description: "Start from a JSON request body; - reads stdin",
  },
];

export const WAIT_FLAGS: readonly FlagSpec[] = [
  {
    name: "output",
    short: "o",
    type: "string",
    placeholder: "<path>",
    section: "Output",
    description: "Save to this file, or into this directory",
  },
  {
    name: "no-download",
    type: "boolean",
    section: "Output",
    description: "Print the result URLs instead of saving files",
  },
  {
    name: "timeout",
    type: "string",
    placeholder: "<duration>",
    section: "Output",
    description: "Stop waiting after this long, like 90s or 20m (default 30m)",
  },
  { name: "open", type: "boolean", section: "Output", description: "Open the file when it is saved" },
  {
    name: "all-files",
    type: "boolean",
    section: "Output",
    description: "Also save intermediate files, like a video's poster frame",
  },
];

export const DEFAULT_TIMEOUT = "30m";

/** `--timeout`, parsed up front so a typo never costs a submit. */
export function timeoutFlag(flags: Record<string, unknown>): number {
  return parseDuration(String(flags.timeout ?? DEFAULT_TIMEOUT));
}

/**
 * Where the API priced something other than what was asked. The estimate
 * clamps quietly (a 99 s request on a 15 s model is priced as 15 s), so the
 * difference is worth a warning before anyone relies on the number.
 */
export function pricingNotes(body: Record<string, unknown>, estimate: Estimate): string[] {
  const notes: string[] = [];
  const asked = body.duration ?? body.duration_seconds;
  const priced = estimate.billing?.duration_seconds;
  if (typeof asked === "number" && typeof priced === "number" && asked !== priced) {
    notes.push(
      `Priced for ${priced}s, not the ${asked}s asked. Check the model's limits: opensume models ${estimate.model}`,
    );
  }
  const askedRes = body.resolution;
  const pricedRes = estimate.billing?.resolution;
  if (typeof askedRes === "string" && pricedRes && askedRes.toLowerCase() !== pricedRes.toLowerCase()) {
    notes.push(`Priced at ${pricedRes}, not the ${askedRes} asked.`);
  }
  return notes;
}

/** Look a model up in the open catalog, with a "did you mean" on a miss. */
export async function resolveModel(ctx: Context, id: string): Promise<CatalogModel> {
  const client = ctx.client();
  try {
    return await client.getModel(id, ctx.signal);
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.apiCode !== "model_not_found")) throw error;
    const models = await client.listModels(ctx.signal).catch(() => [] as CatalogModel[]);
    const guess = closest(
      id,
      models.map((m) => m.id),
    );
    throw new CliError(`No model "${id}" on open.sume.com.`, {
      exitCode: ExitCode.Rejected,
      code: "model_not_found",
      hint: guess
        ? `Did you mean ${guess}? See every model with \`opensume models\`.`
        : "See every model with `opensume models`.",
    });
  }
}

export interface FollowOptions {
  jobId: string;
  /** Parsed `--timeout`, checked before anything was submitted. */
  timeoutMs: number;
  model: string | null | undefined;
  /** When the clock started, for "completed in …". */
  startedAt: number;
  firstDelaySeconds?: number | null | undefined;
  flags: Record<string, unknown>;
  /** The estimate, when one was made. */
  usd?: string | undefined;
  /** Report the job's own run time (created → completed), not time spent waiting here. */
  jobTime?: boolean;
  /** Extra fields for the `--json` document. */
  extra?: Record<string, unknown>;
}

export interface FollowResult {
  status: StatusResponse;
  files: SavedFile[];
  artifacts: Artifact[];
}

/**
 * Wait for a job, then save its files: the shared tail of `run` and
 * `jobs wait`. Returns the exit code.
 */
export async function followJob(ctx: Context, options: FollowOptions): Promise<number> {
  const { ui, json } = ctx;
  const client = ctx.client();
  const { flags } = options;
  const timeoutMs = options.timeoutMs;
  const label = options.model ?? "job";
  const price = options.usd ? ` · ${formatUsd(options.usd)}` : "";
  ctx.jobId = options.jobId;

  const status = await waitForJob(client, options.jobId, {
    timeoutMs,
    signal: ctx.signal,
    firstDelaySeconds: options.firstDelaySeconds,
    sleep: ctx.sleep,
    onStatus: (s) => ui.spin(progressLine(ctx, label + price, s, options.startedAt)),
    onRetry: (error) => ui.debug(`status read failed, retrying: ${error.message}`),
    onDelay: (delay, hint) => ui.debug(`next status read in ${delay}s${hint !== null ? ` (API hint ${hint}s)` : ""}`),
  });
  ui.stopSpinner();

  if (status.sume_status !== "completed") {
    const job = await client.getJob(options.jobId, ctx.signal).catch(() => undefined);
    return reportFailure(ctx, options, status, job);
  }

  const result = await readResult(ctx, options.jobId);
  const artifacts = result.result?.artifacts ?? [];
  const job = result.job ?? status.job;
  const ranMs =
    options.jobTime && job?.completed_at ? Date.parse(job.completed_at) - Date.parse(job.created_at) : Number.NaN;
  const elapsedMs = Number.isFinite(ranMs) ? ranMs : Date.now() - options.startedAt;
  const elapsed = formatDuration(elapsedMs);
  const download = flags["no-download"] !== true;
  const wanted = selectArtifacts(artifacts, flags["all-files"] === true);

  const files: SavedFile[] = [];
  if (download && wanted.length > 0) {
    const paths = await planPaths(wanted, {
      output: flags.output as string | undefined,
      model: options.model,
      jobId: options.jobId,
      cwd: ctx.cwd,
    });
    for (const [i, artifact] of wanted.entries()) {
      const path = paths[i] as string;
      ui.spin(`Saving ${relative(ctx.cwd, path) || path}`);
      const bytes = await downloadTo(artifact.url, path, {
        userAgent: ctx.userAgent,
        signal: ctx.signal,
        sleep: ctx.sleep,
      });
      files.push({ path, bytes, artifact });
    }
    ui.stopSpinner();
  }

  if (json) {
    ui.json({
      job: { id: options.jobId, model: options.model ?? null, status: status.sume_status },
      ...(options.usd ? { usd: options.usd } : {}),
      elapsed_ms: elapsedMs,
      artifacts: artifacts.map((a) => {
        const file = files.find((f) => f.artifact === a);
        return file ? { ...a, path: file.path, bytes: file.bytes } : a;
      }),
      ...options.extra,
    });
  } else {
    ui.success(`${label} completed in ${elapsed}${price}`);
    if (artifacts.length === 0) ui.warn("The job completed without files.");
    if (download) {
      for (const file of files) {
        ui.info(`  ${ctx.ui.c.bold(display(ctx, file.path))}  ${ctx.ui.c.dim(describeFile(file))}`);
      }
      // stdout carries the paths alone, for pipes: `opensume run … | xargs open`.
      if (!ui.options.stdout.isTTY || ui.options.quiet) for (const file of files) ui.out(file.path);
    } else {
      for (const artifact of wanted) ui.out(artifact.url);
    }
    const skipped = artifacts.length - wanted.length;
    if (skipped > 0) {
      ui.info(
        ui.c.dim(
          `  ${skipped} intermediate file${skipped === 1 ? "" : "s"} (like a poster frame) not saved; --all-files keeps them`,
        ),
      );
    }
  }
  if (flags.open === true && files[0]) openFile(files[0].path);
  return ExitCode.Ok;
}

/**
 * The files a person asked for: the job's final outputs. Intermediate files
 * (a `stage`, like a video's poster frame) come along only on request, or
 * when a job returned nothing else.
 */
export function selectArtifacts(artifacts: readonly Artifact[], all: boolean): Artifact[] {
  if (all) return [...artifacts];
  const finals = artifacts.filter((a) => !a.stage);
  return finals.length > 0 ? finals : [...artifacts];
}

const display = (ctx: Context, path: string) => {
  const rel = relative(ctx.cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
};

function describeFile(file: SavedFile): string {
  const parts = [formatBytes(file.bytes)];
  const { width, height, duration_ms } = file.artifact;
  if (width && height) parts.push(`${width}×${height}`);
  if (duration_ms) parts.push(formatDuration(duration_ms));
  parts.push(file.artifact.content_type);
  return parts.join(" · ");
}

function progressLine(ctx: Context, label: string, status: StatusResponse, startedAt: number): string {
  const { c } = ctx.ui;
  const state = status.sume_status;
  const position =
    status.queue_position !== null && status.queue_position !== undefined ? ` #${status.queue_position}` : "";
  const elapsed = formatDuration(Date.now() - startedAt);
  return `${c.bold(label)} ${c.dim("·")} ${state}${position} ${c.dim(`· ${elapsed}`)}`;
}

/**
 * A job can report `completed` a moment before its files are attached, so
 * an empty result is read again for a few seconds before it is believed.
 */
async function readResult(ctx: Context, jobId: string): Promise<ResultResponse> {
  const client = ctx.client();
  let result = await client.getResult(jobId, ctx.signal);
  for (let i = 0; i < 5 && (result.result?.artifacts?.length ?? 0) === 0; i++) {
    await ctx.sleep(1500, ctx.signal);
    result = await client.getResult(jobId, ctx.signal);
  }
  return result;
}

function reportFailure(ctx: Context, options: FollowOptions, status: StatusResponse, job: Job | undefined): number {
  const { ui } = ctx;
  const error = job?.error ?? status.job?.error ?? null;
  const state = status.sume_status;
  const message = error?.message ?? (state === "canceled" ? "The job was canceled." : "The job failed.");
  if (ctx.json) {
    ui.json({
      job: { id: options.jobId, model: options.model ?? null, status: state },
      error: error ?? { message },
      ...options.extra,
    });
  } else {
    ui.error(`${options.model ?? "Job"} ${state}: ${message}`, failureHint(options.jobId, error?.retryable));
  }
  return ExitCode.JobFailed;
}

function failureHint(jobId: string, retryable: boolean | undefined): string {
  const events = `Details: opensume jobs events ${jobId}`;
  return retryable ? `This may pass on a retry. ${events}` : events;
}

/** Open a file with the platform's default app, detached. */
export function openFile(path: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", path]]
        : ["xdg-open", [path]];
  const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

/** The parts of a job a person wants to see in a list or `--json`. */
export function jobRow(job: Job) {
  return {
    id: job.id,
    model: job.model,
    type: job.type,
    status: job.status,
    created_at: job.created_at,
    completed_at: job.completed_at,
  };
}
