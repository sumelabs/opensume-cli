import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { networkReason } from "../api/client.ts";
import type { Context } from "../context.ts";
import type { CommandSpec } from "../lib/args.ts";
import { CliError, ExitCode } from "../lib/errors.ts";
import { VERSION } from "../version.ts";

export const REPO = "sumelabs/opensume-cli";
const NPM_TARBALL = `https://github.com/${REPO}/releases/latest/download/opensume.tgz`;

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
      ui.info(`update it the way you installed it, for example: npm install -g ${NPM_TARBALL}`);
      return ExitCode.Ok;
    }

    const asset = assetName(process.platform, process.arch, isMusl());
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
export function assetName(platform: NodeJS.Platform, arch: string, musl = false): string {
  const os = platform === "win32" ? "windows" : platform;
  if (!["darwin", "linux", "windows"].includes(os) || !["x64", "arm64"].includes(arch)) {
    throw new CliError(`No prebuilt binary for ${platform} ${arch}.`, { code: "unsupported_platform" });
  }
  if (os === "windows" && arch !== "x64") return "opensume-windows-x64.exe";
  return `opensume-${os}-${arch}${os === "linux" && musl ? "-musl" : ""}${os === "windows" ? ".exe" : ""}`;
}

/** Alpine and other musl systems need the musl build; glibc ones cannot run it. */
export function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readdirSync("/lib").some((name) => name.startsWith("ld-musl-"));
  } catch {
    return false;
  }
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/iu.exec(line.trim());
    if (match) sums.set(match[2] as string, (match[1] as string).toLowerCase());
  }
  return sums;
}

/** -1, 0 or 1, by semver precedence: a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", ...rest] = v.replace(/^v/u, "").split("-");
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: rest.join("-") };
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
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/u.test(p);
    const qn = /^\d+$/u.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** True for the single-file binaries the release workflow builds with Bun. */
export function isStandaloneBinary(): boolean {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return Boolean(bun) && basename(process.execPath).toLowerCase().startsWith("opensume");
}

async function latestVersion(ctx: Context): Promise<string | undefined> {
  const res = await ctx
    .fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": ctx.userAgent },
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
    })
    .catch((cause: unknown) => {
      throw new CliError("Could not reach GitHub to check for updates.", { code: "network_error", cause });
    });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new CliError(`GitHub answered ${res.status} while checking for updates.`, {
      code: "update_check_failed",
      hint:
        res.status === 403 || res.status === 429 ? "GitHub limits how often it is asked; try again later." : undefined,
    });
  }
  const release = (await res.json().catch(() => undefined)) as { tag_name?: string } | undefined;
  if (!release)
    throw new CliError("GitHub's answer about the latest release was not JSON.", { code: "update_check_failed" });
  return release.tag_name?.replace(/^v/u, "");
}

/** One release file, whole. Any failure is explained, and nothing is replaced. */
async function fetchBytes(ctx: Context, url: string): Promise<Buffer> {
  const name = url.split("/").pop();
  try {
    const res = await ctx.fetch(url, {
      headers: { "user-agent": ctx.userAgent },
      redirect: "follow",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]),
    });
    if (!res.ok)
      throw new CliError(`Downloading ${name} failed: GitHub answered ${res.status}.`, { code: "download_failed" });
    return Buffer.from(await res.arrayBuffer());
  } catch (cause) {
    if (ctx.signal.aborted || cause instanceof CliError) throw cause;
    throw new CliError(`Downloading ${name} failed (${networkReason(cause)}). Nothing was changed.`, {
      code: "network_error",
      hint: "Run `opensume update` again.",
      cause,
    });
  }
}

/**
 * Swap the running binary. POSIX lets a running file be renamed over;
 * Windows does not, so the old one steps aside as `.old` first.
 */
async function replaceExecutable(target: string, bytes: Buffer): Promise<void> {
  const dir = dirname(target);
  const staged = join(dir, `.${basename(target)}.new`);
  const old = `${target}.old`;
  let movedAside = false;
  try {
    await writeFile(staged, bytes, { mode: 0o755 });
    if (process.platform === "win32") {
      await rm(old, { force: true });
      await rename(target, old);
      movedAside = true;
    }
    await rename(staged, target);
    await chmod(target, 0o755).catch(() => {});
  } catch (cause) {
    await rm(staged, { force: true }).catch(() => {});
    // Never leave the user without a binary: put the old one back.
    if (movedAside) await rename(old, target).catch(() => {});
    throw new CliError(`Could not replace ${target}. Is its folder writable?`, {
      code: "update_failed",
      cause,
      exitCode: ExitCode.Error,
    });
  }
}
