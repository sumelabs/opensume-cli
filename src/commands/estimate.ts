import { basename } from "node:path";
import type { Context } from "../context.ts";
import type { CommandSpec, Parsed } from "../lib/args.ts";
import { buildBody, type InputFlags, localMediaPaths, replaceMedia, routerFor } from "../lib/body.ts";
import { ExitCode, UsageError } from "../lib/errors.ts";
import { unknownFields } from "../lib/schema.ts";
import { formatUsd } from "../lib/ui.ts";
import { INPUT_FLAGS, pricingNotes, resolveModel } from "./shared.ts";

export const estimate: CommandSpec = {
  name: "estimate",
  aliases: ["price"],
  group: "Generate",
  summary: "Price a request in dollars before running it",
  description:
    "Prices the same request `opensume run` would send, with the same input flags, and submits nothing. " +
    "The answer is what an open.sume.com key is charged. No key needed.",
  args: [
    { name: "model", required: true, complete: "models", description: "A model id from `opensume models`" },
    { name: "prompt", description: "The prompt (some models price by its length)" },
  ],
  flags: INPUT_FLAGS,
  examples: [
    "opensume estimate gpt-image-2 -q high",
    "opensume estimate seedance-2-mini -d 8 -r 720p",
    "opensume estimate veed-subtitles --video clip.mp4 -d 45 --captions.style glass",
  ],
  run: estimateCommand,
};

async function estimateCommand(parsed: Parsed, ctx: Context): Promise<number> {
  const { ui } = ctx;
  const flags = parsed.flags as InputFlags;
  const [modelId, positionalPrompt] = parsed.args as [string, string | undefined];
  if (positionalPrompt !== undefined && flags.prompt !== undefined) {
    throw new UsageError("Give the prompt once: as the second argument or with --prompt, not both.");
  }
  ui.spin(`Pricing ${modelId}`);
  const model = await resolveModel(ctx, modelId);
  const body = await buildBody(model, { ...flags, prompt: positionalPrompt ?? flags.prompt });
  // Files are priced by the fields that describe them (duration, resolution),
  // not their bytes, so local paths are not uploaded just to get a price.
  const local = localMediaPaths(body);
  replaceMedia(body, new Map(local.map((p) => [p, `https://upload.invalid/${encodeURIComponent(basename(p))}`])));
  const result = await ctx.client().estimate(model.id, body, ctx.signal);
  ui.stopSpinner();

  const notes = [...unknownFields(routerFor(model), body), ...pricingNotes(body, result)];
  if (ctx.json) {
    ui.json(notes.length ? { ...result, warnings: notes } : result);
    return ExitCode.Ok;
  }
  ui.out(`${ui.c.bold(formatUsd(result.usd))}  ${ui.c.dim(`${model.id} · ${describeBilling(result.billing)}`)}`);
  for (const note of notes) ui.warn(note);
  return ExitCode.Ok;
}

function describeBilling(
  billing:
    | { unit?: string; quantity?: number; duration_seconds?: number | null; resolution?: string | null }
    | undefined,
): string {
  if (!billing) return "per request";
  const parts: string[] = [];
  if (billing.duration_seconds) parts.push(`${billing.duration_seconds}s`);
  if (billing.resolution) parts.push(billing.resolution);
  if (billing.unit && billing.unit !== "usd_micros" && billing.quantity !== undefined) {
    parts.push(`${billing.quantity} × ${billing.unit.replaceAll("_", " ")}`);
  }
  return parts.length ? parts.join(" · ") : "per request";
}
