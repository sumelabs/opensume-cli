import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, ExitCode } from "./errors.ts";

/**
 * Where the Open API lives: Open's production stack, released as `open-v*`.
 * `SUME_API_BASE_URL` or `--base-url` points the CLI anywhere else.
 */
export const DEFAULT_BASE_URL = "https://api.open.sume.com";

/**
 * Open's development API: every main commit, with its own database and keys
 * (made at open.dev.sume.com, for Sume staff). open.sume.com makes keys for
 * the default host.
 */
export const DEV_BASE_URL = "https://open-api-development.up.railway.app";

/** sume.com's own API (the www stack). Open keys and Open routes are not there. */
export const WRONG_BASE_URL = "https://api.sume.com";

/** Where keys are made. */
export const KEYS_URL = "https://open.sume.com/api-keys";

/** How to install the CLI, one line per platform. */
export const INSTALL = {
  sh: "curl -fsSL https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.sh | sh",
  powershell: "irm https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.ps1 | iex",
  npm: "npm install -g https://github.com/sumelabs/opensume-cli/releases/latest/download/opensume.tgz",
  /** No install: run any command through npx (Node 22+). */
  npx: "npx -y https://github.com/sumelabs/opensume-cli/releases/latest/download/opensume.tgz",
} as const;

/** The Open API docs (models, jobs, errors, webhooks). */
export const DOCS_URL = "https://open.sume.com/docs";

export interface StoredConfig {
  api_key?: string;
  base_url?: string;
}

export type Source = "flag" | "env" | "config" | "default";
/** Where the key came from. `dotenv` is `SUME_API_KEY` in `./.env`. */
export type KeySource = "flag" | "env" | "dotenv" | "config";

/** How to name a key's source to a person: `--api-key`, `SUME_API_KEY`, `.env`, `saved key`. */
export function keySourceLabel(source: KeySource | undefined): string {
  if (source === "flag") return "--api-key";
  if (source === "env") return "SUME_API_KEY";
  if (source === "dotenv") return "SUME_API_KEY in ./.env";
  return "saved key";
}

export interface Settings {
  apiKey: string | undefined;
  apiKeySource: KeySource | undefined;
  baseUrl: string;
  baseUrlSource: Source;
  configPath: string;
}

/** `$OPENSUME_CONFIG_DIR`, else the platform's per-user config directory. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.OPENSUME_CONFIG_DIR) return env.OPENSUME_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opensume");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opensume");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

export function readConfig(path: string): StoredConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new CliError(`Cannot read ${path}: ${code === "EACCES" ? "permission denied" : (code ?? "error")}.`, {
      exitCode: ExitCode.Error,
      code: "config_unreadable",
      hint: "Fix its permissions (it should be yours, mode 600), or set OPENSUME_CONFIG_DIR elsewhere.",
      cause: error,
    });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const { api_key, base_url } = parsed as Record<string, unknown>;
    return {
      ...(typeof api_key === "string" && api_key ? { api_key } : {}),
      ...(typeof base_url === "string" && base_url ? { base_url } : {}),
    };
  } catch (cause) {
    throw new CliError(`Cannot read ${path}: it is not valid JSON.`, {
      exitCode: ExitCode.Error,
      code: "invalid_config",
      hint: "Fix or delete the file, then run `opensume auth login` again.",
      cause,
    });
  }
}

/** Write atomically, readable by the owner only (the file holds a key). */
export function writeConfig(path: string, config: StoredConfig): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(`Cannot save ${path}: ${code === "EACCES" ? "permission denied" : (code ?? "error")}.`, {
      exitCode: ExitCode.Error,
      code: "config_unwritable",
      hint: "Set OPENSUME_CONFIG_DIR to a folder you can write, or use SUME_API_KEY instead of a saved key.",
      cause: error,
    });
  }
}

export function removeConfig(path: string): void {
  rmSync(path, { force: true });
}

/**
 * `SUME_API_KEY` from a `.env` file in `cwd`, where projects keep their keys.
 * Only that one variable is read: the API host never comes from a project
 * file, so a cloned repo cannot send your saved key elsewhere.
 */
export function dotEnvKey(cwd: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(cwd, ".env"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?SUME_API_KEY\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[1] as string;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/u, "");
    return value.trim() || undefined;
  }
  return undefined;
}

/** Flags beat environment variables, which beat `./.env` (the key only), which beats the config file. */
export function resolveSettings(
  flags: { apiKey?: string | undefined; baseUrl?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Settings {
  const path = configPath(env);
  const stored = readConfig(path);
  const envKey = env.SUME_API_KEY?.trim();
  const envBase = env.SUME_API_BASE_URL?.trim();

  let apiKey: string | undefined;
  let apiKeySource: Settings["apiKeySource"];
  if (flags.apiKey) [apiKey, apiKeySource] = [flags.apiKey.trim(), "flag"];
  else if (envKey) [apiKey, apiKeySource] = [envKey, "env"];
  else {
    const fromFile = cwd ? dotEnvKey(cwd) : undefined;
    if (fromFile) [apiKey, apiKeySource] = [fromFile, "dotenv"];
    else if (stored.api_key) [apiKey, apiKeySource] = [stored.api_key, "config"];
  }

  let baseUrl = DEFAULT_BASE_URL;
  let baseUrlSource: Source = "default";
  if (flags.baseUrl) [baseUrl, baseUrlSource] = [flags.baseUrl, "flag"];
  else if (envBase) [baseUrl, baseUrlSource] = [envBase, "env"];
  else if (stored.base_url) [baseUrl, baseUrlSource] = [stored.base_url, "config"];

  return { apiKey, apiKeySource, baseUrl, baseUrlSource, configPath: path };
}

/**
 * The key as the API keys page shows it, prefix and last four
 * (`sume_live_Xy12_ab3…9QzK`): enough to tell keys apart, never enough to use.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith("sume_") && trimmed.length >= 30) return `${trimmed.slice(0, 18)}…${trimmed.slice(-4)}`;
  if (trimmed.length <= 12) return "…";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/**
 * What to try when a host refuses a key. Each stack has its own keys, so a
 * good key sent to the other stack is refused as if it were wrong.
 */
export function otherHostHint(baseUrl: string): string {
  const other = baseUrl === DEFAULT_BASE_URL ? DEV_BASE_URL : DEFAULT_BASE_URL;
  return `Keys work only on the API they were made for. If this key is for ${other}, add --base-url ${other}.`;
}
