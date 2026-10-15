import { createHash } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "../context.ts";
import type { CommandSpec } from "../lib/args.ts";
import { CliError, ExitCode } from "../lib/errors.ts";
import { VERSION } from "../version.ts";

export const REPO = "sumelabs/opensume-cli";

export const update: CommandSpec = {
  name: "update",
  group: "Setup",
  summary: "Update to the latest release",
  description:
    "Checks GitHub for the latest release. A standalone binary (from the install script) replaces itself after " +
    "checking the download against the release's SHA-256 checksums; other installs print the command to run. " +
    "The CLI never checks for updates on its own.",
  flags: [{ name: "check", type: "boolean", description: "Only say whether a newer version exists" }],
  run: async (parsed, ctx) => {
    const { ui } = ctx;
    ui.spin("Checking for updates");
    const latest = await latestVersion(ctx);
    ui.stopSpinner();
    const newer = latest !== undefined && compareVersions(latest, VERSION) > 0;
    const standalone = isStandaloneBinary();

    if (ctx.json && (parsed.flags.check === true || !newer || !standalone)) {
      ui.json({ current: VERSION, latest: latest ?? null, update_available: newer, standalone });
      return ExitCode.Ok;
    }
    if (latest === undefined) {
      ui.info(`opensume ${VERSION}. No published release to compare with yet.`);
      return ExitCode.Ok;
    }
    if (!newer) {
      ui.success(`opensume ${VERSION} is the latest version.`);
      return ExitCode.Ok;
    }
    if (parsed.flags.check === true) {
      ui.info(`opensume ${latest} is available (you have ${VERSION}). Run \`opensume update\`.`);
      return ExitCode.Ok;
    }
    if (!standalone) {
      ui.info(
        `opensume ${latest} is available (you have ${VERSION}). This copy was not installed as a standalone binary;`,
      );
      ui.info(`update it the way you installed it, for example: npm install -g github:${REPO}`);
      return ExitCode.Ok;
    }

    const asset = assetName(process.platform, process.arch);
    const base = `https://github.com/${REPO}/releases/download/v${latest}`;
    ui.spin(`Downloading opensume ${latest}`);
    const [binary, sums] = await Promise.all([
      fetchBytes(ctx, `${base}/${asset}`),
      fetchBytes(ctx, `${base}/checksums.txt`),
    ]);
    const expected = parseChecksums(sums.toString("utf8")).get(asset);
    const actual = createHash("sha256").update(binary).digest("hex");
    if (!expected || expected !== actual) {
      throw new CliError(`The download does not match the release checksum; nothing was changed.`, {
        code: "checksum_mismatch",
      });
    }
    await replaceExecutable(process.execPath, binary);
    ui.stopSpinner();
    if (ctx.json) ui.json({ current: latest, previous: VERSION, updated: true });
    else ui.success(`Updated opensume ${VERSION} → ${latest}`);
    return ExitCode.Ok;
  },
};

/** The release asset for this machine, matching install.sh and the release workflow. */
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  if (!["darwin", "linux", "windows"].includes(os) || !["x64", "arm64"].includes(arch)) {
    throw new CliError(`No prebuilt binary for ${platform} ${arch}.`, { code: "unsupported_platform" });
  }
  return `opensume-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/iu.exec(line.trim());
    if (match) sums.set(match[2] as string, (match[1] as string).toLowerCase());
  }
  return sums;
}

/** -1, 0 or 1. Pre-release versions sort before their release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre = ""] = v.replace(/^v/u, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** True for the single-file binaries the release workflow builds with Bun. */
export function isStandaloneBinary(): boolean {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return Boolean(bun) && basename(process.execPath).toLowerCase().startsWith("opensume");
}

async function latestVersion(ctx: Context): Promise<string | undefined> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": ctx.userAgent },
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
  }).catch((cause: unknown) => {
    throw new CliError("Could not reach GitHub to check for updates.", { code: "network_error", cause });
  });
  if (res.status === 404) return undefined;
  if (!res.ok)
    throw new CliError(`GitHub answered ${res.status} while checking for updates.`, { code: "update_check_failed" });
  const release = (await res.json()) as { tag_name?: string };
  return release.tag_name?.replace(/^v/u, "");
}

async function fetchBytes(ctx: Context, url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "user-agent": ctx.userAgent },
    redirect: "follow",
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]),
  });
  if (!res.ok) throw new CliError(`Download failed (${res.status}): ${url}`, { code: "download_failed" });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Swap the running binary. POSIX lets a running file be renamed over;
 * Windows does not, so the old one steps aside as `.old` first.
 */
async function replaceExecutable(target: string, bytes: Buffer): Promise<void> {
  const dir = dirname(target);
  const staged = join(dir, `.${basename(target)}.new`);
  await writeFile(staged, bytes, { mode: 0o755 });
  try {
    if (process.platform === "win32") {
      const old = `${target}.old`;
      await rm(old, { force: true });
      await rename(target, old);
    }
    await rename(staged, target);
    await chmod(target, 0o755).catch(() => {});
  } catch (cause) {
    await rm(staged, { force: true });
    throw new CliError(`Could not replace ${target}. Is it writable?`, {
      code: "update_failed",
      cause,
      exitCode: ExitCode.Error,
    });
  }
}
