import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { SumeClient } from "../api/client.ts";
import type { Asset } from "../api/types.ts";
import { TRANSFER_TIMEOUT_MS } from "./download.ts";
import { CliError, ExitCode } from "./errors.ts";
import { contentTypeFor, MEDIA_EXTENSIONS } from "./media.ts";

export interface UploadedFile {
  path: string;
  url: string;
  asset: Asset;
  sizeBytes: number;
  contentType: string;
}

/**
 * Put a local file in Sume storage and return its media URL, in the three
 * calls the API documents: create an upload URL, PUT the bytes there (with
 * exactly the headers it names, and without the API key), then complete.
 */
export async function uploadFile(
  client: SumeClient,
  path: string,
  options: { signal?: AbortSignal | undefined; fetch?: typeof globalThis.fetch } = {},
): Promise<UploadedFile> {
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

  const target = await client.createUpload(
    { content_type: contentType, size_bytes: info.size, filename: basename(path) },
    options.signal,
  );
  const bytes = await readFile(path);
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
    throw new CliError(`Uploading ${basename(path)} failed: ${reason}.`, {
      code: "network_error",
      hint: "Check your connection and run the command again.",
      cause,
    });
  }
  if (!put.ok) {
    throw new CliError(`Uploading ${basename(path)} failed: storage answered ${put.status}.`, {
      code: "upload_failed",
      hint: "Upload URLs expire quickly; run the command again.",
    });
  }
  const asset = await client.completeUpload(target.asset.id, info.size, options.signal);
  if (!asset.url) {
    throw new CliError(`Sume stored ${basename(path)} but returned no URL for it.`, { code: "upload_incomplete" });
  }
  return { path, url: asset.url, asset, sizeBytes: info.size, contentType };
}
