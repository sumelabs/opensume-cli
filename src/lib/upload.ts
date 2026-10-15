import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { SumeClient } from "../api/client.ts";
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
}

/** Put a local file in Sume storage and return its media URL. */
export async function uploadFile(client: SumeClient, path: string, options: UploadOptions = {}): Promise<UploadedFile> {
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
  const bytes = await readFile(path);
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
    throw new CliError(`Could not fetch ${url}.`, { code: "network_error", cause });
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
  const bytes = Buffer.from(await res.arrayBuffer());
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
  const timeout = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
  let put: Response;
  try {
    // The presigned URL is never printed: it grants write access until it expires.
    put = await (options.fetch ?? globalThis.fetch)(target.upload.url, {
      method: target.upload.method || "PUT",
      headers: target.upload.headers ?? { "content-type": contentType },
      body: bytes,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    const reason = (cause as Error).name === "TimeoutError" ? "timed out" : "the connection failed";
    throw new CliError(`Uploading ${filename} failed: ${reason}.`, {
      code: "network_error",
      hint: "Check your connection and run the command again.",
      cause,
    });
  }
  if (!put.ok) {
    throw new CliError(`Uploading ${filename} failed: storage answered ${put.status}.`, {
      code: "upload_failed",
      hint: "Upload URLs expire quickly; run the command again.",
    });
  }
  const asset = await client.completeUpload(target.asset.id, bytes.length, options.signal);
  if (!asset.url) {
    throw new CliError(`Sume stored ${filename} but returned no URL for it.`, { code: "upload_incomplete" });
  }
  return { url: asset.url, asset, sizeBytes: bytes.length, contentType };
}
