import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "../context.ts";
import type { CommandSpec } from "../lib/args.ts";
import { DEFAULT_BASE_URL, DEV_BASE_URL, DOCS_URL, INSTALL, KEYS_URL, WRONG_BASE_URL } from "../lib/config.ts";
import { CliError, ExitCode } from "../lib/errors.ts";
import { VERSION } from "../version.ts";

const SKILL_URL = "https://raw.githubusercontent.com/sumelabs/opensume-cli/main/skills/opensume/SKILL.md";
const BEGIN = "<!-- BEGIN opensume -->";
const END = "<!-- END opensume -->";

/** The commands an agent needs, in the order it needs them. */
const STEPS = [
  ["opensume models --json", "models, kinds and prices"],
  ["opensume schema <model> --json", "every input; each one is also a flag"],
  ['opensume estimate <model> "<prompt>" --json', "the price in dollars, free"],
  ['opensume run <model> "<prompt>" --max-usd 0.10 -o out/ --json', "submit, wait, save the file"],
  ["opensume jobs wait <job_id> -o out/ --json", "pick up a long or interrupted job"],
] as const;

/**
 * The brief, as Markdown. The same text goes to stdout and, with --write,
 * into a marked block in an AGENTS.md, so it holds nothing machine-specific.
 */
export function agentMarkdown(): string {
  const width = Math.max(...STEPS.map(([command]) => command.length));
  return [
    "## opensume: the Sume Open API from the shell",
    "",
    "Images, video, lip-sync and captions from every open.sume.com model, priced in dollars. Every command takes `--json`.",
    "",
    "**Install**",
    "",
    "```sh",
    INSTALL.sh,
    "```",
    "",
    `Windows: \`${INSTALL.powershell}\`. Node 22+: \`${INSTALL.npm}\`.`,
    "",
    "**API**",
    "",
    `- Base URL: \`${DEFAULT_BASE_URL}\`, the default. \`SUME_API_BASE_URL\` or \`--base-url\` changes it.`,
    `- Not \`${WRONG_BASE_URL}\`: that is sume.com's API, not Open's, and Open keys do not work there.`,
    `- \`${DEV_BASE_URL}\` is Open's development API, for Sume staff, with its own keys (open.dev.sume.com).`,
    `- Docs: ${DOCS_URL}`,
    "",
    "**Key**",
    "",
    `- The CLI reads it from \`SUME_API_KEY\` (made at ${KEYS_URL}). Never paste a key into a chat, a file in the repo, or a command line.`,
    "- Or save it once: `printenv SUME_API_KEY | opensume auth login --with-key`.",
    "- Check it: `opensume auth status --json` answers `valid: true`.",
    "- Raw HTTP sends it as `Authorization: Bearer $SUME_API_KEY`.",
    "",
    "**Use**",
    "",
    "```sh",
    ...STEPS.map(([command, what]) => `${command.padEnd(width)}  # ${what}`),
    "```",
    "",
    "- Always pass `--max-usd`; over it, nothing is submitted (exit 7). A second submit is a second charge: resume with `jobs wait`.",
    "- Exit codes: 0 ok, 2 bad flags, 3 key, 4 input refused, 5 job failed (refunded), 6 timed out, 7 funds or `--max-usd`, 8 rate limit, 130 interrupted.",
    "- Errors in `--json` are `{error: {code, message, hint}}`. `OPENSUME_OUTPUT=json` makes every command print JSON without the flag.",
    `- Every command and flag: \`opensume --help --json\`. Agent skill: ${SKILL_URL}`,
  ].join("\n");
}

export const agent: CommandSpec = {
  name: "agent",
  aliases: ["agents", "quickstart"],
  group: "Setup",
  summary: "Print what an agent needs: install, API host, key, first commands",
  description:
    "One page to hand to a coding agent, as Markdown (or --json): how to install the CLI, the API host and the " +
    "one to avoid, how to pass the key without printing it, and the five commands that do the work. " +
    "With --write, the same page goes into a marked block in an AGENTS.md; running it again replaces the block.",
  flags: [
    {
      name: "write",
      type: "string",
      placeholder: "<file>",
      description: "Add or replace the opensume block in this file, such as AGENTS.md or CLAUDE.md",
    },
  ],
  examples: [
    "opensume agent",
    "opensume agent --write AGENTS.md",
    "opensume agent --json | jq -r .install.sh",
    "opensume agent | pbcopy        # paste it into the agent's instructions",
  ],
  run: async (parsed, ctx) => {
    const target = parsed.flags.write as string | undefined;
    if (target !== undefined) return writeBlock(ctx, target);

    const { apiKey, apiKeySource, baseUrl, baseUrlSource } = ctx.settings;
    if (ctx.json) {
      ctx.ui.json({
        version: VERSION,
        install: INSTALL,
        base_url: baseUrl,
        base_url_source: baseUrlSource,
        default_base_url: DEFAULT_BASE_URL,
        dev_base_url: DEV_BASE_URL,
        wrong_base_url: WRONG_BASE_URL,
        docs: DOCS_URL,
        key: {
          env: "SUME_API_KEY",
          set: Boolean(apiKey),
          source: apiKeySource ?? null,
          create: KEYS_URL,
          save: "printenv SUME_API_KEY | opensume auth login --with-key",
          check: "opensume auth status --json",
          http_header: "Authorization: Bearer $SUME_API_KEY",
        },
        commands: STEPS.map(([command, what]) => ({ command, what })),
        exit_codes: Object.fromEntries(Object.entries(ExitCode).map(([name, code]) => [code, name])),
        skill: SKILL_URL,
        markdown: agentMarkdown(),
      });
      return ExitCode.Ok;
    }

    ctx.ui.out(agentMarkdown());
    // What this machine would use right now, after the shareable part.
    const wrong = hostOf(baseUrl) === hostOf(WRONG_BASE_URL);
    ctx.ui.out("");
    ctx.ui.out("**This machine**");
    ctx.ui.out("");
    ctx.ui.out(`- opensume ${VERSION}`);
    ctx.ui.out(`- API: ${baseUrl} (${baseUrlSource === "default" ? "default" : `from ${baseUrlSource}`})`);
    ctx.ui.out(
      apiKey
        ? `- Key: set (from ${apiKeySource === "env" ? "SUME_API_KEY" : apiKeySource === "flag" ? "--api-key" : "the saved config"}); check it with \`opensume auth status\``
        : `- Key: none. Make one at ${KEYS_URL} and export SUME_API_KEY.`,
    );
    if (wrong)
      ctx.ui.warn(`${baseUrl} is sume.com's API, not Open's. Unset SUME_API_BASE_URL to use ${DEFAULT_BASE_URL}.`);
    return ExitCode.Ok;
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Put the brief between markers in `file`: replace the old block, or append one. */
async function writeBlock(ctx: Context, file: string): Promise<number> {
  const path = resolve(ctx.cwd, file);
  const block = `${BEGIN}\n${agentMarkdown()}\n${END}`;
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let next: string;
  let action: "created" | "updated" | "added";
  const start = existing?.indexOf(BEGIN) ?? -1;
  const end = existing?.indexOf(END, start) ?? -1;
  if (existing === undefined || existing.trim() === "") {
    next = `${block}\n`;
    action = "created";
  } else if (start !== -1 && end !== -1) {
    next = `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
    action = "updated";
  } else if (start !== -1 || existing.includes(END)) {
    throw new CliError(`${file} has only one of the opensume markers.`, {
      exitCode: ExitCode.Usage,
      code: "broken_markers",
      hint: `Remove the stray "${start !== -1 ? BEGIN : END}" line, then run this again.`,
    });
  } else {
    next = `${existing}${existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
    action = "added";
  }
  if (next !== existing) await writeFile(path, next, "utf8");
  if (ctx.json) ctx.ui.json({ path, action: next === existing ? "unchanged" : action });
  else
    ctx.ui.success(
      `${next === existing ? "Already up to date" : `${action[0]?.toUpperCase()}${action.slice(1)}`}: the opensume block in ${file}`,
    );
  return ExitCode.Ok;
}
