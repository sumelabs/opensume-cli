import { SumeClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import type { Context } from "../context.ts";
import type { CommandSpec } from "../lib/args.ts";
import { maskKey, otherHostHint, readConfig, removeConfig, writeConfig } from "../lib/config.ts";
import { CliError, ExitCode, UsageError } from "../lib/errors.ts";
import { readAllStdin, readSecret } from "../lib/prompt.ts";

const KEYS_URL = "https://open.sume.com/api-keys";

const login: CommandSpec = {
  name: "login",
  summary: "Save an API key for this computer",
  description:
    `Checks the key against the API, then stores it in the config file, readable by you only. ` +
    `Create a key at ${KEYS_URL}. SUME_API_KEY, when set, still wins over the saved key.`,
  flags: [{ name: "with-key", type: "boolean", description: "Read the key from stdin instead of prompting" }],
  examples: ["opensume auth login", "printenv SUME_API_KEY | opensume auth login --with-key"],
  run: async (parsed, ctx) => {
    const { ui } = ctx;
    let key: string;
    if (parsed.flags["with-key"] === true) {
      if (process.stdin.isTTY) {
        throw new UsageError(
          "--with-key reads the key from stdin, but stdin is a terminal.",
          "Pipe it in: printenv SUME_API_KEY | opensume auth login --with-key",
        );
      }
      key = (await readAllStdin()).trim();
    } else {
      ui.info(`Create a key at ${ui.c.cyan(KEYS_URL)}, then paste it here.`);
      key = await readSecret("API key: ");
    }
    if (!key) throw new UsageError("No key given.");
    if (/\s/u.test(key)) throw new UsageError("That does not look like an API key: it contains spaces.");

    const verdict = await checkKey(ctx, key);
    if (!verdict.ok) throw verdict.error;

    const stored = readConfig(ctx.settings.configPath);
    const baseUrl = ctx.settings.baseUrlSource === "flag" ? ctx.settings.baseUrl : stored.base_url;
    writeConfig(ctx.settings.configPath, { ...stored, api_key: key, ...(baseUrl ? { base_url: baseUrl } : {}) });
    if (ctx.json) {
      ui.json({ saved: true, key: maskKey(key), config_path: ctx.settings.configPath });
    } else {
      ui.success(`Saved ${maskKey(key)} to ${ctx.settings.configPath}`);
      if (ctx.env.SUME_API_KEY) ui.warn("SUME_API_KEY is set in this shell; it is used before the saved key.");
    }
    return ExitCode.Ok;
  },
};

const status: CommandSpec = {
  name: "status",
  summary: "Show which key and API the CLI uses, and check the key works",
  run: async (_parsed, ctx) => {
    const { ui } = ctx;
    const { apiKey, apiKeySource, baseUrlSource, configPath } = ctx.settings;
    const sources = { flag: "--api-key", env: "SUME_API_KEY", config: configPath };
    const verdict = apiKey ? await checkKey(ctx, apiKey) : undefined;

    if (ctx.json) {
      ui.json({
        api_url: ctx.client().baseUrl,
        api_url_source: baseUrlSource,
        key: apiKey ? maskKey(apiKey) : null,
        key_source: apiKeySource ?? null,
        valid: verdict?.ok ?? false,
        ...(verdict && !verdict.ok
          ? { error: { code: verdict.error.code, message: verdict.error.message, hint: verdict.error.hint ?? null } }
          : {}),
      });
    } else {
      const { c } = ui;
      ui.out(
        `${c.dim("API     ")} ${ctx.client().baseUrl} ${c.dim(baseUrlSource === "default" ? "(default)" : `(from ${baseUrlSource})`)}`,
      );
      if (!apiKey) {
        ui.out(`${c.dim("Key     ")} ${c.yellow("none")}`);
        ui.info(c.dim(`\nCreate a key at ${KEYS_URL}, then run \`opensume auth login\` or export SUME_API_KEY.`));
      } else {
        ui.out(
          `${c.dim("Key     ")} ${maskKey(apiKey)} ${c.dim(`(from ${apiKeySource ? sources[apiKeySource] : "?"})`)}`,
        );
        ui.out(`${c.dim("Check   ")} ${verdict?.ok ? c.green("ok") : c.red(verdict?.error.message ?? "failed")}`);
        if (verdict && !verdict.ok && verdict.error.hint) ui.info(c.dim(`\n${verdict.error.hint}`));
      }
    }
    if (!apiKey) return ExitCode.Auth;
    return verdict?.ok ? ExitCode.Ok : (verdict?.error.exitCode ?? ExitCode.Error);
  },
};

const logout: CommandSpec = {
  name: "logout",
  summary: "Forget the saved key",
  description: `Removes the key from this computer. It does not revoke it: do that at ${KEYS_URL}.`,
  run: async (_parsed, ctx) => {
    const { ui } = ctx;
    const stored = readConfig(ctx.settings.configPath);
    const had = Boolean(stored.api_key);
    if (stored.base_url) writeConfig(ctx.settings.configPath, { base_url: stored.base_url });
    else removeConfig(ctx.settings.configPath);
    if (ctx.json) ui.json({ removed: had });
    else ui.success(had ? "Removed the saved key." : "No saved key.");
    if (!ctx.json && ctx.env.SUME_API_KEY) ui.warn("SUME_API_KEY is still set in this shell.");
    return ExitCode.Ok;
  },
};

export const auth: CommandSpec = {
  name: "auth",
  group: "Setup",
  summary: "Save, check or forget your API key",
  commands: [login, status, logout],
};

/** A cheap authenticated read: one job from the list. Spends nothing. */
async function checkKey(ctx: Context, key: string): Promise<{ ok: true } | { ok: false; error: CliError }> {
  const client = new SumeClient({
    baseUrl: ctx.settings.baseUrl,
    apiKey: key,
    userAgent: ctx.userAgent,
    maxRetries: 1,
  });
  try {
    await client.listJobs({ limit: 1 }, ctx.signal);
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return {
        ok: false,
        error: new CliError(
          error.apiCode === "unauthorized" ? "The API does not accept this key (wrong or revoked)." : error.message,
          {
            exitCode: ExitCode.Auth,
            code: error.apiCode,
            hint:
              error.apiCode === "unauthorized"
                ? `${otherHostHint(client.baseUrl)} Or create a new key at ${KEYS_URL}.`
                : error.hint,
          },
        ),
      };
    }
    if (error instanceof CliError) return { ok: false, error };
    throw error;
  }
}
