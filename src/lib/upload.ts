import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { backoffMs, sleep as defaultSleep, networkReason, type SumeClient } from "../api/client.ts";
import type { Asset } from "../api/types.ts";
import { TRANSFER_TIMEOUT_MS } from "./download.ts";
import { CliError, ExitCode } from "./errors.ts";
import { contentTypeFor, extensionFor, MEDIA_EXTENSIONS } from "./media.ts";

export interface UploadedFile {
  /** The local path, or the URL the bytes were fetched from. */
  path: string;
  url: string;
  asset: Asset;
  sizeBytes: number;
  contentType: string;
}

interface UploadOptions {
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Everything about a local file that can be wrong before any upload: it
 * exists, is a readable file, has bytes, and has a media type. Returns the
 * content type. Commands check all their files first, so a typo in the last
 * one does not leave the others half done.
 */
export async function checkUploadable(path: string): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    throw new CliError(`No such file: ${path}`, { exitCode: ExitCode.Usage, code: "file_not_found" });
  }
  if (!info.isFile()) throw new CliError(`Not a file: ${path}`, { exitCode: ExitCode.Usage, code: "not_a_file" });
  if (info.size === 0) throw new CliError(`Empty file: ${path}`, { exitCode: ExitCode.Usage, code: "empty_file" });
  const contentType = contentTypeFor(path);
  if (!contentType) {
    throw new CliError(`Cannot tell the media type of ${path} from its extension.`, {
      exitCode: ExitCode.Usage,
      code: "unknown_media_type",
      hint: `Use one of ${MEDIA_EXTENSIONS.join(" ")}, or pass a public https URL.`,
    });
  }
  return contentType;
}

/** Put a local file in Sume storage and return its media URL. */
export async function uploadFile(client: SumeClient, path: string, options: UploadOptions = {}): Promise<UploadedFile> {
  const contentType = await checkUploadable(path);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw new CliError(`Cannot read ${path}${code === "EACCES" ? ": permission denied" : ` (${code ?? "error"})`}.`, {
      exitCode: ExitCode.Usage,
      code: "file_unreadable",
      cause,
    });
  }
  return { ...(await uploadBytes(client, bytes, contentType, basename(path), options)), path };
}

/**
 * Copy a file from a URL into Sume storage: for links that expire before a
 * job would read them, or hosts that refuse servers. The bytes pass through
 * this machine; the key is never sent to the source URL.
 */
export async function uploadFromUrl(
  client: SumeClient,
  url: string,
  options: UploadOptions = {},
): Promise<UploadedFile> {
  const timeout = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (options.fetch ?? globalThis.fetch)(url, {
      headers: options.userAgent ? { "user-agent": options.userAgent } : {},
      redirect: "follow",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new CliError(`Could not fetch ${url} (${networkReason(cause)}).`, {
      code: "network_error",
      hint: "Check the URL and your connection; it must be reachable without cookies or a login.",
      cause,
    });
  }
  if (!res.ok) {
    throw new CliError(`Fetching ${url} answered ${res.status}.`, {
      exitCode: ExitCode.Rejected,
      code: "source_unavailable",
      hint: "The URL must be reachable without cookies or a login.",
    });
  }
  const pathname = new URL(res.url || url).pathname;
  const header = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const contentType = header && /^(image|video|audio)\//u.test(header) ? header : contentTypeFor(pathname);
  if (!contentType) {
    throw new CliError(`${url} is not an image, a video or audio (content type ${header ?? "unknown"}).`, {
      exitCode: ExitCode.Usage,
      code: "unknown_media_type",
    });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new CliError(`Could not fetch ${url} (${networkReason(cause)} while reading it).`, {
      code: "network_error",
      hint: "Run the command again.",
      cause,
    });
  }
  if (bytes.length === 0) throw new CliError(`${url} is empty.`, { exitCode: ExitCode.Usage, code: "empty_file" });
  const name = basename(pathname) || "remote";
  const filename = extname(name) ? name : `${name}${extensionFor(contentType)}`;
  return { ...(await uploadBytes(client, bytes, contentType, filename, options)), path: url };
}

/**
 * The three calls the API documents: create an upload URL, PUT the bytes
 * there (with exactly the headers it names, and without the API key), then
 * complete.
 */
async function uploadBytes(
  client: SumeClient,
  bytes: Buffer,
  contentType: string,
  filename: string,
  options: UploadOptions,
): Promise<Omit<UploadedFile, "path">> {
  const target = await client.createUpload(
    { content_type: contentType, size_bytes: bytes.length, filename },
    options.signal,
  );
  // The URL is signed for this exact size, so sending the same bytes again
  // is safe: a dropped connection or a busy store gets two more tries.
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
    let put: Response | undefined;
    let failure: unknown;
    try {
      // The presigned URL is never printed: it grants write access until it expires.
      put = await (options.fetch ?? globalThis.fetch)(target.upload.url, {
        method: target.upload.method || "PUT",
        headers: target.upload.headers ?? { "content-type": contentType },
        body: bytes,
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      await put.arrayBuffer().catch(() => undefined);
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      failure = cause;
    }
    if (put?.ok) break;
    const transient = !put || put.status === 408 || put.status === 429 || put.status >= 500;
    if (attempt < attempts && transient) {
      await (options.sleep ?? defaultSleep)(backoffMs(attempt), options.signal);
      continue;
    }
    const tries = attempt > 1 ? `, tried ${attempt} times` : "";
    if (!put) {
      throw new CliError(`Uploading ${filename} failed (${networkReason(failure)}${tries}).`, {
        code: "network_error",
        hint: "Check your connection and run the command again.",
        cause: failure,
      });
    }
    throw new CliError(`Uploading ${filename} failed: storage answered ${put.status}${tries}.`, {
      code: "upload_failed",
      hint:
        put.status === 403
          ? "The upload URL expired or was refused; run the command again."
          : "Run the command again; quote this if it keeps failing.",
    });
  }
  const asset = await client.completeUpload(target.asset.id, bytes.length, options.signal);
  if (!asset.url) {
    throw new CliError(`Sume stored ${filename} but returned no URL for it.`, { code: "upload_incomplete" });
  }
  return { url: asset.url, asset, sizeBytes: bytes.length, contentType };
}
