import { basename, resolve } from "node:path";
import type { CommandSpec } from "../lib/args.ts";
import { CliError, ExitCode } from "../lib/errors.ts";
import { isHttpUrl } from "../lib/media.ts";
import { formatBytes } from "../lib/ui.ts";
import { checkUploadable, type UploadedFile, uploadFile, uploadFromUrl } from "../lib/upload.ts";

export const upload: CommandSpec = {
  name: "upload",
  group: "Generate",
  summary: "Upload files (or copy URLs) to Sume storage and print their media URLs",
  description:
    "Stores files in Sume storage with your key and prints a URL for each, ready for any media field. " +
    "Give a URL to copy a remote file in, for links that expire or hosts that refuse servers. " +
    "`opensume run` uploads local files for you. Uploading is free.",
  args: [
    { name: "files", required: true, variadic: true, description: "Local files or https URLs: images, clips or audio" },
  ],
  examples: [
    "opensume upload ./photo.png ./voice.wav",
    "opensume upload https://example.com/shared/clip.mp4",
    'opensume run kling-3 "slow push in" --image "$(opensume upload ./still.png)"',
  ],
  run: async (parsed, ctx) => {
    const { ui } = ctx;
    // Every local file is checked before the first upload, and the key too.
    for (const path of parsed.args) if (!isHttpUrl(path)) await checkUploadable(resolve(ctx.cwd, path));
    ctx.client().requireKey();

    const uploaded: UploadedFile[] = [];
    const failed: { path: string; error: CliError }[] = [];
    for (const path of parsed.args) {
      ui.spin(`Uploading ${basename(path)}`);
      let file: UploadedFile;
      try {
        file = isHttpUrl(path)
          ? await uploadFromUrl(ctx.client(), path, { signal: ctx.signal, userAgent: ctx.userAgent, sleep: ctx.sleep })
          : await uploadFile(ctx.client(), resolve(ctx.cwd, path), { signal: ctx.signal, sleep: ctx.sleep });
      } catch (error) {
        // A refused key fails every file alike; anything else is this file's own trouble.
        if (ctx.signal.aborted || !(error instanceof CliError) || error.exitCode === ExitCode.Auth) throw error;
        ui.stopSpinner();
        failed.push({ path, error });
        if (!ctx.json) ui.error(error.message, error.hint);
        continue;
      }
      uploaded.push(file);
      ui.stopSpinner();
      if (!ctx.json) {
        ui.info(
          `${ui.c.green("✓")} ${basename(path)} ${ui.c.dim(`${formatBytes(file.sizeBytes)} · ${file.contentType}`)}`,
        );
        ui.out(file.url);
      }
    }
    const rows = uploaded.map((f) => ({
      path: f.path,
      url: f.url,
      asset_id: f.asset.id,
      size_bytes: f.sizeBytes,
      content_type: f.contentType,
    }));
    if (failed.length === 0) {
      if (ctx.json) ui.json(rows);
      return ExitCode.Ok;
    }
    const first = failed[0] as { path: string; error: CliError };
    const message = `Uploaded ${uploaded.length} of ${parsed.args.length}; ${failed.map((f) => f.path).join(", ")} failed.`;
    const hint = `Upload ${failed.length === 1 ? "it" : "them"} again with: opensume upload ${failed.map((f) => f.path).join(" ")}`;
    if (ctx.json) {
      ui.json({
        error: { code: first.error.code, message, hint },
        uploaded: rows,
        failed: failed.map((f) => ({ path: f.path, code: f.error.code, message: f.error.message })),
      });
    } else if (failed.length < parsed.args.length) {
      ui.error(message, hint);
    }
    return first.error.exitCode;
  },
};
