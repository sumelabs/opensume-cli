import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { backoffMs, networkReason, sleep } from "../api/client.ts";
import type { Artifact } from "../api/types.ts";
import { CliError, UsageError } from "./errors.ts";
import { extensionFor } from "./media.ts";

export interface SavedFile {
  path: string;
  bytes: number;
  artifact: Artifact;
  /** It was already there from an earlier run (`jobs wait` after a partial save), so it was not fetched again. */
  existing?: boolean;
}

export interface PlannedPath {
  path: string;
  /** A finished download of this artifact is already at `path`. */
  existing: boolean;
}

/** File-system failures a retry cannot fix, in words a person reads. */
const LOCAL_ERRORS: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "permission denied",
  EROFS: "the disk is read-only",
  ENOSPC: "the disk is full",
  EDQUOT: "the disk quota is used up",
  EISDIR: "a folder has that name",
  ENOTDIR: "part of the path is a file, not a folder",
  EEXIST: "part of the path is a file, not a folder",
  ENAMETOOLONG: "the name is too long",
  EMFILE: "too many files are open",
  ENFILE: "too many files are open",
};

/**
 * A local write failure as an explained error, or undefined for anything
 * else. `elsewhere` says how to pick another place, for this command.
 */
export function localWriteError(
  path: string,
  error: unknown,
  elsewhere = "Save somewhere you can write to with -o.",
): CliError | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const reason = code ? LOCAL_ERRORS[code] : undefined;
  if (!reason) return undefined;
  const full = code === "ENOSPC" || code === "EDQUOT";
  return new CliError(`Cannot write ${path}: ${reason}.`, {
    code: full ? "disk_full" : "write_failed",
    hint: full ? "Free some space, then run it again." : elsewhere,
    cause: error,
  });
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

async function isFinishedFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Before anything is paid for or waited on: the folder files will be saved
 * in must be writable, or creatable inside a writable folder. A job whose
 * file cannot be saved is a job paid for twice.
 */
export async function checkWritable(output: string | undefined, cwd: string): Promise<void> {
  let dir: string;
  let file: string | undefined;
  if (!output) dir = cwd;
  else if (isTemplate(output)) dir = dirname(resolve(cwd, output.replace(/\{[a-z_]+\}/gu, "x")));
  else {
    const full = resolve(cwd, output);
    if (isDirectoryHint(output) || (await isDirectory(full))) dir = full;
    else [dir, file] = [dirname(full), full];
  }
  const fail = (why: string) =>
    new UsageError(
      `Cannot save files to ${relative(cwd, dir) || "."}: ${why}.`,
      "Pick a folder you can write to with -o, or pass --no-download to print the URLs instead.",
    );
  // A named file that is there already is overwritten, so it must be writable too.
  if (file && (await exists(file))) {
    await access(file, constants.W_OK).catch(() => {
      throw fail(`${basename(file as string)} is not writable`);
    });
  }
  // The nearest folder that exists decides; the rest is created when saving.
  for (let probe = dir; ; ) {
    const info = await stat(probe).catch(() => undefined);
    if (info) {
      if (!info.isDirectory()) throw fail(`${relative(cwd, probe) || probe} is a file, not a folder`);
      await access(probe, constants.W_OK).catch(() => {
        throw fail(`${relative(cwd, probe) || probe} is not writable`);
      });
      return;
    }
    const parent = dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}

/**
 * Where each artifact goes. With no `-o`, files land in the working
 * directory as `<model>-<job>.<ext>` and never overwrite anything. A named
 * file is written as given (the first artifact) and numbered after that.
 */
export async function planPaths(artifacts: readonly Artifact[], options: PlanOptions): Promise<PlannedPath[]> {
  const exts = artifacts.map((a) => extensionFor(a.content_type, a.url, a.type));
  const fresh = (path: string): PlannedPath => ({ path, existing: false });
  if (options.output && isTemplate(options.output)) {
    return fillTemplate(options.output, artifacts, exts, options).map(fresh);
  }
  const many = artifacts.length > 1;
  const stem = `${(options.model ?? "sume").replace(/[^A-Za-z0-9._-]+/gu, "-")}-${shortJobId(options.jobId)}`;

  const output = options.output ? resolve(options.cwd, options.output) : undefined;
  const intoDirectory =
    output === undefined || (options.output && isDirectoryHint(options.output)) || (await isDirectory(output));

  if (intoDirectory) {
    const dir = output ?? options.cwd;
    const taken = new Set<string>();
    const paths: PlannedPath[] = [];
    for (const [i, ext] of exts.entries()) {
      let candidate = join(dir, `${stem}${many ? `-${i + 1}` : ""}${ext}`);
      // Files reach their final name only when complete (see downloadTo), so a
      // file under this job's own name is a finished download: keep it, so a
      // second `jobs wait` fetches only what is missing.
      if (!taken.has(candidate) && (await isFinishedFile(candidate))) {
        taken.add(candidate);
        paths.push({ path: candidate, existing: true });
        continue;
      }
      for (let n = 2; taken.has(candidate) || (await exists(candidate)); n++) {
        candidate = join(dir, `${stem}${many ? `-${i + 1}` : ""}-${n}${ext}`);
      }
      taken.add(candidate);
      paths.push(fresh(candidate));
    }
    return paths;
  }

  // The first file takes the name as given; the rest are numbered and keep
  // their own type's extension (a poster frame stays .jpg next to boat.mp4).
  const file = output as string;
  const given = extname(file);
  const base = given ? file.slice(0, -given.length) : file;
  return exts.map((ext, i) => fresh(i === 0 ? `${base}${given || ext}` : `${base}-${i + 1}${ext}`));
}

/** A whole download or upload may take this long; a stalled one is retried. */
export const TRANSFER_TIMEOUT_MS = 15 * 60_000;

export interface DownloadOptions {
  userAgent: string;
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch;
  attempts?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** What the file should be, from the artifact: checked before it gets its name. */
  expect?: {
    bytes?: number | null | undefined;
    sha256?: string | null | undefined;
    /** image, video, audio…: an HTML page or an empty body in its place is an error page, not the file. */
    kind?: string | undefined;
  };
}

const retryable = (message: string) => Object.assign(new Error(message), { retryable: true });

/**
 * Stream one URL to `path` through a `.part` file, so an interrupted
 * download never leaves a truncated file under the final name.
 */
export async function downloadTo(url: string, path: string, options: DownloadOptions): Promise<number> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const attempts = options.attempts ?? 3;
  const expect = options.expect ?? {};
  const media = expect.kind !== undefined && expect.kind !== "file";
  const part = `${path}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      await mkdir(dirname(path), { recursive: true });
      const timeout = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
      const res = await fetcher(url, {
        headers: { "user-agent": options.userAgent },
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: res.status === 429 || res.status >= 500 });
      }
      // A captive portal or a proxy error page arrives as 200 text/html.
      const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (media && type === "text/html") throw retryable("got a web page instead of the file");
      const hash = createHash("sha256");
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), tap, createWriteStream(part));
      const bytes = (await stat(part)).size;
      if (media && bytes === 0) throw retryable("the download was empty");
      // Content-Length counts the bytes on the wire; a compressed response
      // decodes to more, so the check only holds for an uncompressed one.
      const expected = res.headers.get("content-encoding") ? Number.NaN : Number(res.headers.get("content-length"));
      if (Number.isFinite(expected) && expected > 0 && expected !== bytes) {
        throw retryable(`got ${bytes} of ${expected} bytes`);
      }
      if (expect.bytes && expect.bytes !== bytes) throw retryable(`got ${bytes} bytes, the job says ${expect.bytes}`);
      if (expect.sha256 && hash.digest("hex") !== expect.sha256.toLowerCase()) {
        throw retryable("the file does not match its checksum");
      }
      await rename(part, path);
      return bytes;
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      if (options.signal?.aborted) throw error;
      // The disk, not the network: retrying cannot help.
      const local = localWriteError(path, error);
      if (local) throw local;
      const timedOut = (error as Error).name === "TimeoutError";
      const again = timedOut || ((error as { retryable?: boolean }).retryable ?? true);
      if (attempt < attempts && again) {
        await (options.sleep ?? sleep)(backoffMs(attempt), options.signal);
        continue;
      }
      const reason =
        (error as { retryable?: boolean }).retryable !== undefined ? (error as Error).message : networkReason(error);
      throw new CliError(
        `Could not download ${basename(new URL(url).pathname)} (${reason}${attempt > 1 ? `, tried ${attempt} times` : ""}).`,
        { code: "download_failed", hint: `The file is still at ${url}`, cause: error },
      );
    }
  }
}

const TOKENS = ["model", "job", "job_id", "index", "ext", "type"] as const;

export const isTemplate = (output: string) => /\{[a-z_]+\}/u.test(output);

/** Refuse a template with tokens the CLI does not fill, before anything is paid for. */
export function checkTemplate(output: string | undefined): void {
  if (!output || !isTemplate(output)) return;
  for (const [, token] of output.matchAll(/\{([a-z_]+)\}/gu)) {
    if (!(TOKENS as readonly string[]).includes(token as string)) {
      throw new UsageError(
        `-o has an unknown token {${token}}.`,
        `Use ${TOKENS.map((t) => `{${t}}`).join(", ")}; for example -o "out/{model}-{job}-{index}.{ext}".`,
      );
    }
  }
}

/**
 * \`-o "out/{model}-{job}-{index}.{ext}"\`: one name per file. Without
 * {index}, several files get -2, -3…; without {ext}, the type's extension
 * is added. Named files are overwritten, like any explicit -o name.
 */
function fillTemplate(
  template: string,
  artifacts: readonly Artifact[],
  exts: string[],
  options: PlanOptions,
): string[] {
  checkTemplate(template);
  return artifacts.map((artifact, i) => {
    const ext = (exts[i] as string).replace(/^\./u, "");
    let name = template
      .replaceAll("{model}", (options.model ?? "sume").replace(/[^A-Za-z0-9._-]+/gu, "-"))
      .replaceAll("{job_id}", options.jobId)
      .replaceAll("{job}", shortJobId(options.jobId))
      .replaceAll("{index}", String(i + 1))
      .replaceAll("{type}", artifact.type)
      .replaceAll("{ext}", ext);
    const given = extname(name);
    if (!template.includes("{index}") && i > 0) {
      name = given ? `${name.slice(0, -given.length)}-${i + 1}${given}` : `${name}-${i + 1}`;
    }
    if (!template.includes("{ext}") && !extname(name)) name = `${name}.${ext}`;
    return resolve(options.cwd, name);
  });
}
