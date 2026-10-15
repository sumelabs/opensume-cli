import type { Job, JobEvent } from "../api/types.ts";
import type { Context } from "../context.ts";
import type { CommandSpec } from "../lib/args.ts";
import { ExitCode } from "../lib/errors.ts";
import { formatAge, formatDuration } from "../lib/ui.ts";
import { followJob, jobRow, WAIT_FLAGS } from "./shared.ts";

const STATES = ["queued", "processing", "completed", "failed", "canceled"] as const;
const jobArg = [{ name: "id", required: true, description: "The job id (job_…)" }] as const;

const list: CommandSpec = {
  name: "list",
  aliases: ["ls"],
  summary: "List your workspace's jobs, newest first",
  flags: [
    { name: "limit", short: "l", type: "number", placeholder: "<n>", description: "How many, 1–100 (default 20)" },
    { name: "status", short: "s", type: "string", choices: STATES, description: "Only jobs in this state" },
    { name: "type", type: "string", placeholder: "<type>", description: "Only this job type, like image_generation" },
    {
      name: "after",
      type: "string",
      placeholder: "<cursor>",
      description: "The next page, from the cursor the last page printed",
    },
  ],
  examples: [
    "opensume jobs list",
    "opensume jobs list --status processing",
    "opensume jobs list --json | jq -r '.jobs[].id'",
  ],
  run: async (parsed, ctx) => {
    const { ui } = ctx;
    const limit = (parsed.flags.limit as number | undefined) ?? 20;
    ui.spin("Loading jobs");
    const page = await ctx.client().listJobs(
      {
        limit,
        ...(parsed.flags.status ? { status: parsed.flags.status as string } : {}),
        ...(parsed.flags.type ? { type: parsed.flags.type as string } : {}),
        ...(parsed.flags.after ? { starting_after: parsed.flags.after as string } : {}),
      },
      ctx.signal,
    );
    ui.stopSpinner();
    if (ctx.json) {
      ui.json({ jobs: page.jobs.map(jobRow), next_cursor: page.next_cursor ?? null });
      return ExitCode.Ok;
    }
    if (page.jobs.length === 0) {
      ui.info("No jobs.");
      return ExitCode.Ok;
    }
    const { c } = ui;
    ui.table(
      ["JOB", "MODEL", "STATUS", "CREATED", "TOOK"],
      page.jobs.map((job) => [
        job.id,
        job.model ?? c.dim("—"),
        paintState(ctx, job.status),
        formatAge(job.created_at),
        took(job),
      ]),
    );
    if (page.next_cursor) ui.info(c.dim(`\nMore: opensume jobs list --after ${page.next_cursor}`));
    return ExitCode.Ok;
  },
};

const get: CommandSpec = {
  name: "get",
  aliases: ["show"],
  summary: "Show a job: its input, state, timing, error and files",
  args: jobArg,
  run: async (parsed, ctx) => {
    const { ui } = ctx;
    const job = await ctx.client().getJob(parsed.args[0] as string, ctx.signal);
    if (ctx.json) {
      ui.json(job);
      return ExitCode.Ok;
    }
    const { c } = ui;
    const field = (label: string, value: string) => ui.out(`${c.dim(label.padEnd(11))}${value}`);
    field("Job", c.bold(job.id));
    field("Model", job.model ?? "—");
    field("Type", job.type);
    field("Status", paintState(ctx, job.status));
    field("Created", `${job.created_at} (${formatAge(job.created_at)})`);
    if (job.completed_at) field("Took", took(job));
    if (job.input && Object.keys(job.input).length) {
      ui.out(c.dim("Input"));
      for (const [key, value] of Object.entries(job.input)) {
        ui.out(`  ${c.dim(`${key}:`)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
      }
    }
    if (job.error) field("Error", c.red(job.error.message ?? job.error.code ?? "failed"));
    for (const artifact of job.result?.artifacts ?? [])
      field("File", `${artifact.url} ${c.dim(artifact.content_type)}`);
    return ExitCode.Ok;
  },
};

const status: CommandSpec = {
  name: "status",
  summary: "Read a job's status once",
  args: jobArg,
  run: async (parsed, ctx) => {
    const { ui } = ctx;
    const { data } = await ctx.client().getStatus(parsed.args[0] as string, ctx.signal);
    if (ctx.json) {
      ui.json(data);
      return ExitCode.Ok;
    }
    const position =
      data.queue_position !== null && data.queue_position !== undefined ? ` (#${data.queue_position} in queue)` : "";
    ui.out(`${data.job_id}  ${paintState(ctx, data.sume_status)}${position}`);
    const next: Record<string, string> = {
      poll_status: `Wait for it: opensume jobs wait ${data.job_id}`,
      fetch_result: `Save the files: opensume jobs wait ${data.job_id}`,
      inspect_events: `See why: opensume jobs events ${data.job_id}`,
    };
    ui.info(ui.c.dim(next[data.next_action] ?? ""));
    return ExitCode.Ok;
  },
};

const wait: CommandSpec = {
  name: "wait",
  aliases: ["download"],
  summary: "Wait for a job to finish and save its files",
  description:
    "Picks up a job from `opensume run --no-wait`, an interrupted run, or another machine, and saves its files like `opensume run` does.",
  args: jobArg,
  flags: WAIT_FLAGS,
  examples: ["opensume jobs wait job_7513b52d-3669-4ffe-b317-8b02000715eb -o ./out/"],
  run: async (parsed, ctx) => {
    const id = parsed.args[0] as string;
    const job = await ctx.client().getJob(id, ctx.signal);
    return followJob(ctx, {
      jobId: job.id,
      model: job.model,
      startedAt: Date.parse(job.created_at) || Date.now(),
      firstDelaySeconds: 0,
      jobTime: true,
      flags: parsed.flags as Record<string, unknown>,
    });
  },
};

const cancel: CommandSpec = {
  name: "cancel",
  summary: "Cancel a job that has not started generating",
  description:
    "Only a job still waiting for the model can be canceled; its price is refunded. Most jobs start within a second.",
  args: jobArg,
  run: async (parsed, ctx) => {
    const { ui } = ctx;
    const res = await ctx.client().cancelJob(parsed.args[0] as string, ctx.signal);
    if (ctx.json) ui.json(res);
    else ui.success(`Canceled ${res.job_id}`);
    return ExitCode.Ok;
  },
};

const events: CommandSpec = {
  name: "events",
  summary: "Show a job's lifecycle events, including why it failed",
  args: jobArg,
  flags: [{ name: "limit", short: "l", type: "number", placeholder: "<n>", description: "How many events" }],
  run: async (parsed, ctx) => {
    const { ui } = ctx;
    const res = await ctx
      .client()
      .listEvents(parsed.args[0] as string, parsed.flags.limit as number | undefined, ctx.signal);
    if (ctx.json) {
      ui.json(res);
      return ExitCode.Ok;
    }
    const { c } = ui;
    const first = res.events[0] ? Date.parse(res.events[0].created_at) : 0;
    for (const event of res.events) {
      const offset = first ? `+${formatDuration(Date.parse(event.created_at) - first)}` : "";
      ui.out(
        `${c.dim(offset.padStart(8))}  ${paintEvent(ctx, event)}${event.message ? `  ${c.dim(event.message)}` : ""}`,
      );
      const error = (event.data as { error?: { message?: string } } | undefined)?.error;
      if (error?.message) ui.out(`${" ".repeat(10)}${c.red(error.message)}`);
    }
    return ExitCode.Ok;
  },
};

export const jobs: CommandSpec = {
  name: "jobs",
  aliases: ["job"],
  group: "Models and jobs",
  summary: "List, wait for, inspect and cancel jobs",
  commands: [list, get, status, wait, cancel, events],
};

function took(job: Job): string {
  if (!job.completed_at) return "";
  const start = Date.parse(job.started_at ?? job.created_at);
  const end = Date.parse(job.completed_at);
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(end - start) : "";
}

function paintState(ctx: Context, state: string): string {
  const { c } = ctx.ui;
  if (state === "completed") return c.green(state);
  if (state === "failed") return c.red(state);
  if (state === "canceled") return c.yellow(state);
  return c.cyan(state);
}

function paintEvent(ctx: Context, event: JobEvent): string {
  const { c } = ctx.ui;
  if (event.status === "failed") return c.red(event.type);
  if (event.status === "succeeded") return c.green(event.type);
  return event.type;
}
