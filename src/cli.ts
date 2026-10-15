import { ApiError } from "./api/errors.ts";
import { auth } from "./commands/auth.ts";
import { complete } from "./commands/complete.ts";
import { completionCommand } from "./commands/completion.ts";
import { doctor } from "./commands/doctor.ts";
import { estimate } from "./commands/estimate.ts";
import { jobs } from "./commands/jobs.ts";
import { models } from "./commands/models.ts";
import { run } from "./commands/run.ts";
import { renderInputs, schema, vendoredRouter } from "./commands/schema.ts";
import { update } from "./commands/update.ts";
import { upload } from "./commands/upload.ts";
import { version, versionInfo } from "./commands/version.ts";
import { createContext } from "./context.ts";
import { type CommandSpec, findSubcommand, type Parsed, parse } from "./lib/args.ts";
import { DEFAULT_BASE_URL, DOCS_URL, resolveSettings } from "./lib/config.ts";
import { CliError, ExitCode, UsageError } from "./lib/errors.ts";
import { renderHelp } from "./lib/help.ts";
import { colorEnabled, type Stream, Ui } from "./lib/ui.ts";
import { VERSION } from "./version.ts";

export const GLOBAL_FLAGS = [
  { name: "json", type: "boolean", description: "Print one JSON document on stdout, for scripts and agents" },
  {
    name: "api-key",
    type: "string",
    placeholder: "<key>",
    description: "Use this key (default: SUME_API_KEY, then the saved key)",
  },
  {
    name: "base-url",
    type: "string",
    placeholder: "<url>",
    description: `API host (default: SUME_API_BASE_URL, then ${DEFAULT_BASE_URL})`,
  },
  { name: "quiet", type: "boolean", description: "Print results only; no progress or notes" },
  { name: "verbose", type: "boolean", description: "Print every API call with its status and request id" },
  { name: "no-color", type: "boolean", description: "Plain text, no color (also: NO_COLOR=1)" },
  { name: "help", short: "h", type: "boolean", description: "Show help" },
  { name: "version", short: "v", type: "boolean", description: "Print the version" },
] as const satisfies CommandSpec["flags"];

const help: CommandSpec = {
  name: "help",
  group: "Setup",
  summary: "Show help for a command",
  args: [{ name: "command", variadic: true, description: "The command, like `run` or `jobs wait`" }],
  run: async () => ExitCode.Ok, // Handled in main, which knows the whole tree.
};

export const root: CommandSpec = {
  name: "opensume",
  summary: "images and video from your terminal, on the Sume Open API",
  description:
    "Run any open.sume.com model, wait for the job, and get the file. Prices are in dollars and shown before you spend. " +
    "Every command takes --json for scripts and agents.",
  flags: GLOBAL_FLAGS,
  commands: [
    run,
    estimate,
    upload,
    models,
    schema,
    jobs,
    auth,
    doctor,
    completionCommand(() => root),
    update,
    version,
    help,
    complete,
  ],
};

export interface MainOptions {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: Stream;
  stderr?: Stream;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Run the CLI and return its exit code. Never calls process.exit. */
export async function main(options: MainOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const wantsJson = options.argv.includes("--json");
  // Color only when both streams are terminals, so no escape code ever lands
  // in a pipe or a file (results go to stdout, progress to stderr).
  const color = (off: boolean) =>
    colorEnabled(stderr, env, off ? false : undefined) && colorEnabled(stdout, env, off ? false : undefined);
  // Before parsing succeeds, report errors the way the flags ask for.
  let ui = new Ui({
    stdout,
    stderr,
    color: color(options.argv.includes("--no-color")),
    interactive: false,
    quiet: false,
    verbose: false,
  });

  let parsed: Parsed;
  try {
    parsed = parse(root, options.argv);
  } catch (error) {
    return report(ui, error, wantsJson);
  }
  const flags = parsed.flags;
  const json = flags.json === true;
  const quiet = flags.quiet === true || json;
  ui = new Ui({
    stdout,
    stderr,
    color: color(flags["no-color"] === true),
    interactive: !quiet && Boolean(stderr.isTTY) && env.CI === undefined,
    quiet,
    verbose: flags.verbose === true,
  });

  try {
    if (flags.version === true && parsed.path.length === 0) {
      const info = versionInfo();
      if (json) ui.json(info);
      else ui.out(`opensume ${VERSION}`);
      return ExitCode.Ok;
    }
    if (parsed.command === help || flags.help === true || (parsed.command === root && parsed.args.length === 0)) {
      const chain = parsed.command === help ? chainFor(parsed.args) : chainFor(parsed.path);
      if (json) ui.json(manifest(chain[chain.length - 1] === root ? undefined : chain));
      else ui.out(renderHelp(chain, ui.c, ui.width).trimEnd());
      // `run <model> --help` also shows what that model takes, like `opensume schema <model>`.
      const modelId = parsed.command !== help ? parsed.args[0] : undefined;
      const router =
        modelId && (parsed.command === run || parsed.command === estimate) ? vendoredRouter(modelId) : undefined;
      if (!json && modelId && router) {
        ui.out("");
        for (const line of renderInputs(modelId, router, ui.c, ui.width)) ui.out(line);
      }
      return ExitCode.Ok;
    }
    if (!parsed.command.run) {
      // A command group with no subcommand (`opensume jobs`) shows its help.
      const chain = chainFor(parsed.path);
      if (json) ui.json(manifest(chain));
      else ui.out(renderHelp(chain, ui.c, ui.width).trimEnd());
      return ExitCode.Ok;
    }

    const settings = resolveSettings(
      { apiKey: flags["api-key"] as string | undefined, baseUrl: flags["base-url"] as string | undefined },
      env,
    );
    const controller = new AbortController();
    const onSigint = () => {
      controller.abort(Object.assign(new Error("Interrupted."), { name: "AbortError" }));
      // A second Ctrl-C quits at once, with the terminal's cursor restored.
      process.once("SIGINT", () => {
        ui.stopSpinner();
        process.exit(ExitCode.Interrupted);
      });
    };
    if (!options.signal) process.once("SIGINT", onSigint);
    options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
    const ctx = createContext({
      ui,
      json,
      settings,
      cwd: options.cwd ?? process.cwd(),
      env,
      signal: controller.signal,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    try {
      return (await parsed.command.run(parsed, ctx)) ?? ExitCode.Ok;
    } catch (error) {
      if (controller.signal.aborted) return interrupted(ui, json, ctx);
      return report(ui, error, json, ctx);
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  } catch (error) {
    return report(ui, error, json);
  } finally {
    ui.stopSpinner();
  }
}

/** What an error after a submit must still tell the person: how to get the job back. */
interface JobContext {
  jobId?: string | undefined;
  idempotencyKey?: string | undefined;
}

function jobFields(job: JobContext | undefined): Record<string, string> {
  if (job?.jobId) return { job_id: job.jobId };
  if (job?.idempotencyKey) return { idempotency_key: job.idempotencyKey };
  return {};
}

function jobHint(job: JobContext | undefined): string | undefined {
  if (job?.jobId) return `Job ${job.jobId} was created. Check on it with: opensume jobs wait ${job.jobId}`;
  if (job?.idempotencyKey) {
    return `If the submit went through, rerun with --idempotency-key ${job.idempotencyKey} to get that job back instead of paying again.`;
  }
  return undefined;
}

function chainFor(names: readonly string[]): CommandSpec[] {
  const chain: CommandSpec[] = [root];
  for (const name of names) {
    const next = findSubcommand(chain[chain.length - 1] as CommandSpec, name);
    if (!next) throw new UsageError(`No command "${names.join(" ")}".`, "Run `opensume --help` to see the commands.");
    chain.push(next);
  }
  return chain;
}

function interrupted(ui: Ui, json: boolean, job: JobContext): number {
  ui.stopSpinner();
  if (json) {
    ui.json({ error: { code: "interrupted", message: "Interrupted.", ...jobFields(job) } });
  } else if (job.jobId) {
    ui.error(
      `Stopped waiting. Job ${job.jobId} keeps running on Sume.`,
      `Pick it up with: opensume jobs wait ${job.jobId}`,
    );
  } else {
    ui.error("Interrupted.", jobHint(job));
  }
  return ExitCode.Interrupted;
}

/** Print an error the way the output mode asks for, and pick the exit code. */
function report(ui: Ui, error: unknown, json: boolean, job?: JobContext): number {
  ui.stopSpinner();
  if (error instanceof CliError) {
    const lines = error instanceof ApiError ? error.fieldErrors() : [];
    if (json) {
      ui.json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.hint ? { hint: error.hint } : {}),
          ...(error instanceof ApiError
            ? {
                status: error.status,
                request_id: error.requestId ?? null,
                retryable: error.retryable,
                ...(error.details !== undefined ? { details: error.details } : {}),
              }
            : {}),
          ...jobFields(job),
        },
      });
    } else {
      const detail = lines.length ? `\n${lines.map((l) => `  • ${l}`).join("\n")}` : "";
      const requestId = error instanceof ApiError && error.requestId ? ` (request ${error.requestId})` : "";
      ui.error(`${error.message}${requestId}${detail}`, [error.hint, jobHint(job)].filter(Boolean).join("\n  "));
    }
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) ui.json({ error: { code: "internal_error", message, ...jobFields(job) } });
  else {
    ui.error(
      `Unexpected error: ${message}`,
      [jobHint(job), "Please report it: https://github.com/sumelabs/opensume-cli/issues"].filter(Boolean).join("\n  "),
    );
    if (error instanceof Error && error.stack && ui.options.verbose) ui.debug(error.stack);
  }
  return ExitCode.Error;
}

/** `--help --json`: the command tree, generated from the same specs as help. */
export function manifest(chain?: readonly CommandSpec[]) {
  const describe = (command: CommandSpec, path: string[]): unknown => ({
    command: ["opensume", ...path].join(" "),
    summary: command.summary,
    ...(command.description ? { description: command.description } : {}),
    ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    args: (command.args ?? []).map((a) => ({
      name: a.name,
      required: a.required ?? false,
      variadic: a.variadic ?? false,
      description: a.description,
    })),
    flags: (command.flags ?? [])
      .filter((f) => !f.hidden)
      .map((f) => ({
        name: `--${f.name}`,
        ...(f.short ? { short: `-${f.short}` } : {}),
        type: f.type,
        ...(f.multiple ? { repeatable: true } : {}),
        ...(f.choices ? { choices: f.choices } : {}),
        description: f.description,
      })),
    ...(command.examples?.length ? { examples: command.examples.filter((e) => !e.startsWith("#")) } : {}),
    ...(command.commands?.length
      ? { commands: command.commands.filter((c) => !c.hidden).map((c) => describe(c, [...path, c.name])) }
      : {}),
  });
  if (chain && chain.length > 1) {
    return describe(
      chain[chain.length - 1] as CommandSpec,
      chain.slice(1).map((c) => c.name),
    );
  }
  return {
    name: "opensume",
    version: VERSION,
    description: root.summary,
    api: { default_base_url: DEFAULT_BASE_URL, docs: DOCS_URL },
    env: {
      SUME_API_KEY: "API key (open.sume.com → API keys)",
      SUME_API_BASE_URL: `API host, default ${DEFAULT_BASE_URL}`,
      OPENSUME_CONFIG_DIR: "Where the saved key lives",
      NO_COLOR: "Disable color",
    },
    exit_codes: Object.fromEntries(Object.entries(ExitCode).map(([name, code]) => [code, name])),
    global_flags: (root.flags ?? []).map((f) => ({ name: `--${f.name}`, type: f.type, description: f.description })),
    commands: (root.commands ?? []).filter((c) => !c.hidden).map((c) => describe(c, [c.name])),
  };
}
