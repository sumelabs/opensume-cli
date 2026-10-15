import { stat } from "node:fs/promises";
import { ApiError } from "../api/errors.ts";
import type { Context } from "../context.ts";
import type { CommandSpec } from "../lib/args.ts";
import { DEFAULT_BASE_URL, maskKey, otherHostHint, WRONG_BASE_URL } from "../lib/config.ts";
import { ExitCode } from "../lib/errors.ts";
import { VERSION } from "../version.ts";
import { compareVersions, isStandaloneBinary, REPO } from "./update.ts";
import { versionInfo } from "./version.ts";

type Verdict = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: Verdict;
  detail: string;
  /** What to do about a warn or fail. */
  fix?: string;
  /** The exit code a failure maps to. */
  exit?: number;
}

export const doctor: CommandSpec = {
  name: "doctor",
  group: "Setup",
  summary: "Check the install, the key and the connection to the API",
  description:
    "Runs every check that matters before a generation: CLI version and updates, config file, API host and build, " +
    "the model catalog, your key, and the media host. Exits non-zero when a check fails. Spends nothing.",
  examples: ["opensume doctor", "opensume doctor --json"],
  run: async (_parsed, ctx) => {
    const { ui } = ctx;
    ui.spin("Checking");
    const checks = await runChecks(ctx);
    ui.stopSpinner();
    if (ctx.json) {
      ui.json({ ok: checks.every((c) => c.status !== "fail"), checks });
    } else {
      const { c } = ui;
      const width = Math.max(...checks.map((x) => x.name.length));
      for (const check of checks) {
        const mark = check.status === "ok" ? c.green("✓") : check.status === "warn" ? c.yellow("!") : c.red("✗");
        ui.out(`${mark} ${check.name.padEnd(width)}  ${check.detail}`);
        if (check.fix && check.status !== "ok") ui.out(`  ${" ".repeat(width)}  ${c.dim(check.fix)}`);
      }
    }
    return checks.find((c) => c.status === "fail")?.exit ?? ExitCode.Ok;
  },
};

async function timed<T>(work: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = performance.now();
  try {
    const value = await work();
    return { value, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { error, ms: Math.round(performance.now() - started) };
  }
}

async function runChecks(ctx: Context): Promise<Check[]> {
  const checks: Check[] = [];
  const info = versionInfo();
  checks.push({
    name: "CLI",
    status: "ok",
    detail: `opensume ${VERSION} (${info.runtime}, ${info.platform} ${info.arch}${isStandaloneBinary() ? ", standalone" : ""})`,
  });

  const signal = (ms: number) => AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]);
  const latest = await timed(async () => {
    const res = await ctx.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": ctx.userAgent },
      signal: signal(8000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return ((await res.json()) as { tag_name?: string }).tag_name?.replace(/^v/u, "");
  });
  if (latest.value && compareVersions(latest.value, VERSION) > 0) {
    checks.push({ name: "Update", status: "warn", detail: `${latest.value} is out`, fix: "Run `opensume update`." });
  } else if (latest.value) {
    checks.push({ name: "Update", status: "ok", detail: "latest release" });
  } else {
    checks.push({ name: "Update", status: "warn", detail: "could not check GitHub for releases" });
  }

  const { configPath, apiKey, apiKeySource } = ctx.settings;
  const config = await timed(() => stat(configPath));
  if (config.value) {
    const mode = config.value.mode & 0o777;
    const open = process.platform !== "win32" && (mode & 0o077) !== 0;
    checks.push({
      name: "Config",
      status: open ? "warn" : "ok",
      detail: `${configPath}${process.platform === "win32" ? "" : ` (mode ${mode.toString(8)})`}`,
      ...(open ? { fix: `Others can read your key: chmod 600 ${configPath}` } : {}),
    });
  } else {
    checks.push({ name: "Config", status: "ok", detail: `${configPath} (not created; no saved key)` });
  }

  const client = ctx.client();
  const health = await timed(async () => {
    const res = await ctx.fetch(`${client.baseUrl}/health`, {
      headers: { "user-agent": ctx.userAgent },
      signal: signal(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      build?: { commit_sha?: string; source_branch?: string };
    };
    return { status: res.status, surface: res.headers.get("x-sume-api-surface"), body };
  });
  if (health.value && health.value.status < 500) {
    const sha = health.value.body.build?.commit_sha?.slice(0, 9);
    // `open-v0.2.0` on Open production, `main` on the development stack.
    const branch = health.value.body.build?.source_branch;
    const surface = health.value.surface;
    // api.sume.com answers /health too, but it is sume.com's API: no Open routes, no Open keys.
    const wrongHost = new URL(client.baseUrl).host === new URL(WRONG_BASE_URL).host;
    checks.push({
      name: "API",
      status: wrongHost ? "fail" : surface !== "public" ? "warn" : "ok",
      detail: `${client.baseUrl} · ${health.value.body.status ?? health.value.status}${sha ? ` · build ${sha}${branch ? ` (${branch})` : ""}` : ""}${surface ? ` · ${surface}` : ""} · ${health.ms}ms`,
      ...(wrongHost
        ? {
            fix: `This is sume.com's API, not Open's. Use ${DEFAULT_BASE_URL}: unset SUME_API_BASE_URL or pass --base-url ${DEFAULT_BASE_URL}.`,
            exit: ExitCode.Usage,
          }
        : surface !== "public"
          ? { fix: "This host does not say it serves the public Open API; keys belong on the public one." }
          : {}),
    });
  } else {
    checks.push({
      name: "API",
      status: "fail",
      detail: `${client.baseUrl} did not answer (${errorText(health.error) ?? health.value?.status})`,
      fix: "Check your connection, or SUME_API_BASE_URL / --base-url.",
      exit: ExitCode.Error,
    });
  }

  const catalog = await timed(() => client.listModels(signal(15_000)));
  if (catalog.value) {
    checks.push({
      name: "Models",
      status: "ok",
      detail: `${catalog.value.length} models in the open catalog · ${catalog.ms}ms`,
    });
  } else {
    checks.push({
      name: "Models",
      status: "fail",
      detail: `the catalog did not load (${errorText(catalog.error)})`,
      exit: ExitCode.Error,
    });
  }

  if (!apiKey) {
    checks.push({
      name: "Key",
      status: "fail",
      detail: "none",
      fix: "Create a key at https://open.sume.com/api-keys, then `opensume auth login` or export SUME_API_KEY.",
      exit: ExitCode.Auth,
    });
  } else {
    const check = await timed(() => client.listJobs({ limit: 1 }, signal(15_000)));
    const source = apiKeySource === "env" ? "SUME_API_KEY" : apiKeySource === "flag" ? "--api-key" : "saved key";
    if (check.value) {
      checks.push({ name: "Key", status: "ok", detail: `${maskKey(apiKey)} (${source}) · accepted · ${check.ms}ms` });
    } else {
      const auth = check.error instanceof ApiError && (check.error.status === 401 || check.error.status === 403);
      checks.push({
        name: "Key",
        status: "fail",
        detail: `${maskKey(apiKey)} (${source}) · ${auth ? "refused (wrong or revoked)" : errorText(check.error)}`,
        fix: auth
          ? `${otherHostHint(client.baseUrl)} Or create a new key at https://open.sume.com/api-keys.`
          : "Retry; quote the request id if it persists.",
        exit: auth ? ExitCode.Auth : ExitCode.Error,
      });
    }
  }

  const media = await timed(async () => {
    const res = await ctx.fetch("https://media.sume.com/", {
      method: "HEAD",
      headers: { "user-agent": ctx.userAgent },
      signal: signal(10_000),
    });
    return res.status;
  });
  checks.push(
    media.value !== undefined
      ? { name: "Media", status: "ok", detail: `media.sume.com reachable · ${media.ms}ms` }
      : {
          name: "Media",
          status: "fail",
          detail: `media.sume.com did not answer (${errorText(media.error)}); results cannot be downloaded`,
          exit: ExitCode.Error,
        },
  );
  return checks;
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.name === "TimeoutError" ? "timed out" : error.message;
  return String(error);
}
