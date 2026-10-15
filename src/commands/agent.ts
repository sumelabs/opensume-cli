import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { CommandSpec } from "../lib/args.ts";
import { DEFAULT_BASE_URL, DOCS_URL, INSTALL, KEYS_URL, keySourceLabel, WRONG_BASE_URL } from "../lib/config.ts";
import { localWriteError } from "../lib/download.ts";
import { CliError, ExitCode, UsageError } from "../lib/errors.ts";
import { VERSION } from "../version.ts";
import { type BriefModel, briefLimits, briefModels, briefPrice } from "./models.ts";

const BEGIN = "<!-- BEGIN opensume -->";
const END = "<!-- END opensume -->";
const SKILL_DESCRIPTION =
  "Generate images, video, lip-sync and captions with the Sume Open API through the `opensume` CLI. Use when the user " +
  "asks to make or edit an image or a video clip, lip-sync a face to speech, burn captions into a video, compare media " +
  "models or their prices, or check on a Sume generation job.";

/** The commands of "Make something", with what each does. */
const STEPS = [
  ["opensume models --brief", "pick a model: price per image or second, inputs, limits"],
  ['opensume run gpt-image-2 "a red kite over a beach" -q low -o out/', "waits, saves, prints the file path"],
  ['opensume run seedance-2-mini "a paper boat" -d 4 -r 480p --max-usd 0.50 -o out/ --json', ""],
] as const;

/**
 * The page an agent follows, as Markdown. It is the one source for
 * `opensume agent`, the AGENTS.md block, the Claude skill and the Cursor
 * rule, so it holds nothing machine-specific.
 */
export function agentMarkdown(): string {
  const width = Math.max(...STEPS.filter(([, what]) => what).map(([command]) => command.length));
  return [
    "## opensume: images and video from the Sume Open API",
    "",
    "`opensume` runs any open.sume.com model from the shell: it prices the request in dollars, waits for the job, and saves the file.",
    "",
    "**Setup, once**",
    "",
    "```sh",
    INSTALL.sh,
    "```",
    "",
    `Windows: \`${INSTALL.powershell}\`. No install, with Node 22+: put \`${INSTALL.npx}\` where these examples say \`opensume\`.`,
    "",
    `- Key: \`SUME_API_KEY\`, read from the environment or from \`./.env\`. A person makes it at ${KEYS_URL}. Never print it, and never paste it into a chat or a command line.`,
    `- Host: \`${DEFAULT_BASE_URL}\`, the default; nothing to set. Never \`${WRONG_BASE_URL}\`: that is sume.com's API, and Open keys fail there.`,
    "- Check both: `opensume doctor`.",
    "",
    "**Make something**",
    "",
    "```sh",
    ...STEPS.map(([command, what]) => (what ? `${command.padEnd(width)}  # ${what}` : command)),
    "```",
    "",
    "- Name the model yourself: prices differ by more than 100× between models. Before a large spend, show the user `opensume estimate` with the same flags (free).",
    '- `run` prints the saved file\'s path. With `--json` it prints `{"job", "usd", "artifacts": [{"path", "url", "content_type"}]}`; `OPENSUME_OUTPUT=json` does that without the flag.',
    "- Cap the spend with `--max-usd`, or `OPENSUME_MAX_USD` for every run. Over the cap nothing is submitted (exit 7).",
    "- Local files work wherever a URL does (`--image ./photo.png`, `--video`, `--audio`). Every field in `opensume schema <model>` is also a flag, like `--captions.style glass`.",
    "- Long video: `--no-wait` returns the job id at once, and `opensume jobs wait <job> -o out/` saves it later. After a timeout (exit 6) or Ctrl-C (130) the job keeps running: resume it with `jobs wait`. Never resubmit; a second submit is a second charge.",
    "",
    "**When it fails**",
    "",
    "Exit codes: 1 network or server (retry), 2 bad flags, 3 key (follow `error.hint`), 4 input refused (fix what `error.message` says), " +
      "5 job failed (refunded; `opensume jobs get <job>` says why), 6 timed out, 7 balance or cap, 8 rate limit, " +
      "130 stopped by Ctrl-C or SIGTERM (the job keeps running; `jobs wait` it). " +
      "Exit 1 after a finished job means a file was not saved: run the command the error prints; it fetches only the missing files. " +
      'With `--json`, errors are `{"error": {"code", "message", "hint", "request_id"}}`. ' +
      `Every command and flag: \`opensume --help --json\`. Docs: ${DOCS_URL}`,
  ].join("\n");
}

/** The page as a Claude Code skill (`.claude/skills/opensume/SKILL.md`, and this repo's `skills/`). */
export function skillMarkdown(): string {
  return `---\nname: opensume\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${agentMarkdown()}\n`;
}

/** The page as a Cursor rule (`.cursor/rules/opensume.mdc`), applied when the agent finds it relevant. */
export function cursorRule(): string {
  return `---\ndescription: "${SKILL_DESCRIPTION.replaceAll('"', '\\"')}"\nglobs:\nalwaysApply: false\n---\n\n${agentMarkdown()}\n`;
}

export const agent: CommandSpec = {
  name: "agent",
  aliases: ["agents", "quickstart"],
  group: "Setup",
  summary: "Print what an agent needs: setup, the models and their prices, how to run",
  description:
    "One page for a coding agent, as Markdown (or --json): the install line, where the key comes from, the API host and " +
    "the one to avoid, the commands that make a file, and what each exit code means. Then what this machine uses, and " +
    "every model with its price per image or second from the live catalog (free, no key). " +
    "`opensume init` writes the same page into the project's agent files.",
  flags: [
    {
      name: "write",
      type: "string",
      placeholder: "<file>",
      description: "Add or replace the opensume block in this one file instead of printing",
    },
  ],
  examples: [
    "opensume agent",
    "opensume agent --json | jq '.models[] | select(.kind == \"video\")'",
    "opensume agent --write CLAUDE.md",
  ],
  run: async (parsed, ctx) => {
    const target = parsed.flags.write as string | undefined;
    if (target !== undefined) {
      const result = await writeBlockFile(resolve(ctx.cwd, target));
      if (ctx.json) ctx.ui.json(result);
      else ctx.ui.success(`${verb(result.action)} the opensume block in ${target}`);
      return ExitCode.Ok;
    }

    const { apiKey, apiKeySource, baseUrl, baseUrlSource } = ctx.settings;
    // The catalog is public, so the page can carry live prices without a key.
    let models: BriefModel[] | undefined;
    let modelsError: string | undefined;
    try {
      models = briefModels(await ctx.client().listModels(AbortSignal.any([ctx.signal, AbortSignal.timeout(8000)])));
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      modelsError = (error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message;
    }

    if (ctx.json) {
      ctx.ui.json({
        version: VERSION,
        install: INSTALL,
        base_url: baseUrl,
        base_url_source: baseUrlSource,
        default_base_url: DEFAULT_BASE_URL,
        wrong_base_url: WRONG_BASE_URL,
        docs: DOCS_URL,
        key: {
          env: "SUME_API_KEY",
          also_read_from: ".env",
          set: Boolean(apiKey),
          source: apiKeySource ?? null,
          create: KEYS_URL,
          http_header: "Authorization: Bearer $SUME_API_KEY",
        },
        spend_cap_env: "OPENSUME_MAX_USD",
        models: models ?? null,
        ...(modelsError ? { models_error: modelsError } : {}),
        exit_codes: Object.fromEntries(Object.entries(ExitCode).map(([name, code]) => [code, name])),
        init: "opensume init",
        markdown: agentMarkdown(),
      });
      return ExitCode.Ok;
    }

    const { ui } = ctx;
    ui.out(agentMarkdown());
    ui.out("");
    ui.out("**This machine**");
    ui.out("");
    ui.out(`- opensume ${VERSION}`);
    ui.out(`- API: ${baseUrl} (${baseUrlSource === "default" ? "default" : `from ${baseUrlSource}`})`);
    ui.out(
      apiKey
        ? `- Key: set, from ${keySourceLabel(apiKeySource)}. \`opensume auth status\` checks it.`
        : `- Key: none. A person makes one at ${KEYS_URL}; then export SUME_API_KEY or put it in ./.env.`,
    );
    if (ctx.env.OPENSUME_MAX_USD) ui.out(`- Spend cap: $${ctx.env.OPENSUME_MAX_USD} a run (OPENSUME_MAX_USD)`);
    ui.out("");
    if (models) {
      ui.out("**Models now** (live catalog; cheapest first in each kind)");
      ui.out("");
      ui.out("```text");
      for (const line of plainTable(
        ["MODEL", "KIND", "PRICE", "INPUTS", "LIMITS"],
        models.map((m) => [m.id, m.kind, briefPrice(m), m.inputs.join(", "), briefLimits(m)]),
      ))
        ui.out(line);
      ui.out("```");
    } else {
      ui.out(`**Models now**: the catalog did not load (${modelsError}). Run \`opensume models --brief\` later.`);
    }
    if (hostOf(baseUrl) === hostOf(WRONG_BASE_URL))
      ui.warn(`${baseUrl} is sume.com's API, not Open's. Unset SUME_API_BASE_URL to use ${DEFAULT_BASE_URL}.`);
    return ExitCode.Ok;
  },
};

type Target = "agents" | "claude" | "cursor";
const TARGETS: readonly Target[] = ["agents", "claude", "cursor"];
const TARGET_PATHS: Record<Target, string> = {
  agents: "AGENTS.md",
  claude: ".claude/skills/opensume/SKILL.md",
  cursor: ".cursor/rules/opensume.mdc",
};

export const init: CommandSpec = {
  name: "init",
  group: "Setup",
  summary: "Write the agent page into this project: AGENTS.md, a Claude skill, a Cursor rule",
  description:
    "Puts the page `opensume agent` prints where coding agents read instructions, so the next session knows the CLI " +
    "without being told: a marked block in AGENTS.md (Codex, Cursor, Amp and others), .claude/skills/opensume/SKILL.md " +
    "(Claude Code), and .cursor/rules/opensume.mdc when the project has a .cursor folder. Run it again to refresh them; " +
    "it touches nothing else and makes no network calls. Commit the files so every agent on the project gets them.",
  flags: [
    {
      name: "targets",
      type: "string",
      placeholder: "<list>",
      description:
        "Only these, comma-separated: agents, claude, cursor (default: agents and claude, plus cursor if .cursor/ exists)",
    },
  ],
  examples: ["opensume init", "opensume init --targets agents", "opensume init --targets agents,claude,cursor --json"],
  run: async (parsed, ctx) => {
    const targets = await chooseTargets(ctx.cwd, parsed.flags.targets as string | undefined);
    const files: { target: Target; path: string; action: Action }[] = [];
    for (const target of targets) {
      const path = resolve(ctx.cwd, TARGET_PATHS[target]);
      const result =
        target === "agents"
          ? await writeBlockFile(path)
          : await writeWholeFile(path, target === "claude" ? skillMarkdown() : cursorRule());
      files.push({ target, ...result });
    }
    const next = 'opensume models --brief, then opensume run <model> "<prompt>" -o out/';
    if (ctx.json) {
      ctx.ui.json({ files, next });
      return ExitCode.Ok;
    }
    for (const file of files) ctx.ui.success(`${verb(file.action)} ${relative(ctx.cwd, file.path)}`);
    ctx.ui.info(ctx.ui.c.dim(`\nCommit them so every agent on this project reads them. Next: ${next}`));
    return ExitCode.Ok;
  },
};

async function chooseTargets(cwd: string, flag: string | undefined): Promise<Target[]> {
  if (flag !== undefined) {
    const names = flag
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const wrong = names.find((name) => !(TARGETS as readonly string[]).includes(name));
    if (wrong !== undefined || names.length === 0) {
      throw new UsageError(`--targets takes agents, claude and cursor (got "${wrong ?? flag}").`);
    }
    return [...new Set(names)] as Target[];
  }
  const hasCursor = await stat(resolve(cwd, ".cursor")).then(
    (s) => s.isDirectory(),
    () => false,
  );
  return hasCursor ? ["agents", "claude", "cursor"] : ["agents", "claude"];
}

type Action = "created" | "added" | "updated" | "unchanged";

function verb(action: Action): string {
  return action === "unchanged" ? "Already up to date:" : `${action[0]?.toUpperCase()}${action.slice(1)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function plainTable(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(head), ...rows.map(line)];
}

async function readIfThere(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(
      `Cannot read ${path}: ${code === "EISDIR" ? "it is a folder" : code === "EACCES" ? "permission denied" : (code ?? "error")}.`,
      { exitCode: ExitCode.Usage, code: "file_unreadable", cause: error },
    );
  }
}

/** A file the CLI owns outright (the skill, the rule): write it whole. */
async function writeWholeFile(path: string, content: string): Promise<{ path: string; action: Action }> {
  const existing = await readIfThere(path);
  if (existing === content) return { path, action: "unchanged" };
  await save(path, content);
  return { path, action: existing === undefined ? "created" : "updated" };
}

async function save(path: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  } catch (error) {
    throw (
      localWriteError(path, error, "Check the folder's permissions, or write to another file with --write.") ?? error
    );
  }
}

/** A file the project owns (AGENTS.md): replace only the block between the markers, or append one. */
async function writeBlockFile(path: string): Promise<{ path: string; action: Action }> {
  const existing = await readIfThere(path);
  const { next, action } = mergeBlock(existing, `${BEGIN}\n${agentMarkdown()}\n${END}`, path);
  if (action !== "unchanged") await save(path, next);
  return { path, action };
}

function mergeBlock(existing: string | undefined, block: string, name: string): { next: string; action: Action } {
  if (existing === undefined || existing.trim() === "") return { next: `${block}\n`, action: "created" };
  const start = existing.indexOf(BEGIN);
  const end = start === -1 ? -1 : existing.indexOf(END, start);
  if (start !== -1 && end !== -1) {
    const next = `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
    return { next, action: next === existing ? "unchanged" : "updated" };
  }
  if (start !== -1 || existing.includes(END)) {
    throw new CliError(`${name} has only one of the opensume markers.`, {
      exitCode: ExitCode.Usage,
      code: "broken_markers",
      hint: `Remove the stray "${start !== -1 ? BEGIN : END}" line, then run this again.`,
    });
  }
  const gap = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { next: `${existing}${gap}${block}\n`, action: "added" };
}
