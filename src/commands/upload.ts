import { basename, resolve } from "node:path";
import type { CommandSpec } from "../lib/args.ts";
import { ExitCode } from "../lib/errors.ts";
import { isHttpUrl } from "../lib/media.ts";
import { formatBytes } from "../lib/ui.ts";
import { type UploadedFile, uploadFile, uploadFromUrl } from "../lib/upload.ts";

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
    const uploaded: UploadedFile[] = [];
    for (const path of parsed.args) {
      ui.spin(`Uploading ${basename(path)}`);
      const file = isHttpUrl(path)
        ? await uploadFromUrl(ctx.client(), path, { signal: ctx.signal, userAgent: ctx.userAgent })
        : await uploadFile(ctx.client(), resolve(ctx.cwd, path), { signal: ctx.signal });
      uploaded.push(file);
      ui.stopSpinner();
      if (!ctx.json) {
        ui.info(
          `${ui.c.green("✓")} ${basename(path)} ${ui.c.dim(`${formatBytes(file.sizeBytes)} · ${file.contentType}`)}`,
        );
        ui.out(file.url);
      }
    }
    if (ctx.json) {
      ui.json(
        uploaded.map((f) => ({
          path: f.path,
          url: f.url,
          asset_id: f.asset.id,
          size_bytes: f.sizeBytes,
          content_type: f.contentType,
        })),
      );
    }
    return ExitCode.Ok;
  },
};
