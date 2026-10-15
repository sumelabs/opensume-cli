import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { backoffMs, sleep } from "../api/client.ts";
import type { Artifact } from "../api/types.ts";
import { CliError } from "./errors.ts";
import { extensionFor } from "./media.ts";

export interface SavedFile {
  path: string;
  bytes: number;
  artifact: Artifact;
}

export interface PlanOptions {
  /** `-o`: a file, a directory (existing, or ending in a separator). */
  output?: string | undefined;
  model: string | null | undefined;
  jobId: string;
  cwd: string;
}

/** `job_7513b52d-3669-…` → `7513b52d`. */
export const shortJobId = (jobId: string) => jobId.replace(/^job_/u, "").split("-")[0]?.slice(0, 8) || jobId;

const isDirectoryHint = (path: string) => path.endsWith("/") || path.endsWith(sep);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where each artifact goes. With no `-o`, files land in the working
 * directory as `<model>-<job>.<ext>` and never overwrite anything. A named
 * file is written as given (the first artifact) and numbered after that.
 */
export async function planPaths(artifacts: readonly Artifact[], options: PlanOptions): Promise<string[]> {
  const exts = artifacts.map((a) => extensionFor(a.content_type, a.url, a.type));
  const many = artifacts.length > 1;
  const stem = `${(options.model ?? "sume").replace(/[^A-Za-z0-9._-]+/gu, "-")}-${shortJobId(options.jobId)}`;

  const output = options.output ? resolve(options.cwd, options.output) : undefined;
  const intoDirectory =
    output === undefined || (options.output && isDirectoryHint(options.output)) || (await isDirectory(output));

  if (intoDirectory) {
    const dir = output ?? options.cwd;
    const taken = new Set<string>();
    const paths: string[] = [];
    for (const [i, ext] of exts.entries()) {
      let candidate = join(dir, `${stem}${many ? `-${i + 1}` : ""}${ext}`);
      for (let n = 2; taken.has(candidate) || (await exists(candidate)); n++) {
        candidate = join(dir, `${stem}${many ? `-${i + 1}` : ""}-${n}${ext}`);
      }
      taken.add(candidate);
      paths.push(candidate);
    }
    return paths;
  }

  // The first file takes the name as given; the rest are numbered and keep
  // their own type's extension (a poster frame stays .jpg next to boat.mp4).
  const file = output as string;
  const given = extname(file);
  const base = given ? file.slice(0, -given.length) : file;
  return exts.map((ext, i) => (i === 0 ? `${base}${given || ext}` : `${base}-${i + 1}${ext}`));
}

export interface DownloadOptions {
  userAgent: string;
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch;
  attempts?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Stream one URL to `path` through a `.part` file, so an interrupted
 * download never leaves a truncated file under the final name.
 */
export async function downloadTo(url: string, path: string, options: DownloadOptions): Promise<number> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const attempts = options.attempts ?? 3;
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetcher(url, {
        headers: { "user-agent": options.userAgent },
        signal: options.signal ?? null,
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        const retryable = res.status === 429 || res.status >= 500;
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryable });
      }
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(part));
      const bytes = (await stat(part)).size;
      const expected = Number(res.headers.get("content-length"));
      if (Number.isFinite(expected) && expected > 0 && expected !== bytes) {
        throw Object.assign(new Error(`got ${bytes} of ${expected} bytes`), { retryable: true });
      }
      await rename(part, path);
      return bytes;
    } catch (error) {
      await rm(part, { force: true });
      if (options.signal?.aborted) throw error;
      const retryable = (error as { retryable?: boolean }).retryable ?? true;
      if (attempt < attempts && retryable) {
        await (options.sleep ?? sleep)(backoffMs(attempt), options.signal);
        continue;
      }
      throw new CliError(`Could not download ${basename(new URL(url).pathname)} (${(error as Error).message}).`, {
        code: "download_failed",
        hint: `The file is still at ${url}`,
        cause: error,
      });
    }
  }
}
