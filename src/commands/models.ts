import type { CatalogModel } from "../api/types.ts";
import type { Context } from "../context.ts";
import { type CommandSpec, closest, type Parsed } from "../lib/args.ts";
import { ExitCode } from "../lib/errors.ts";
import { formatUsd, wrap } from "../lib/ui.ts";

const KINDS = ["image", "video", "lipsync", "captions"] as const;

export const models: CommandSpec = {
  name: "models",
  aliases: ["model", "ls"],
  group: "Models and jobs",
  summary: "List the models and their prices, or show one",
  description:
    "Lists every model open.sume.com serves, with its starting price in dollars. " +
    "Give an exact model id to see its inputs, price options and limits; give any other word to filter the list. No key needed.",
  args: [{ name: "query", complete: "models", description: "A model id for its details, or text to filter by" }],
  flags: [
    { name: "kind", short: "k", type: "string", choices: KINDS, description: "Only this kind of model" },
    {
      name: "company",
      short: "c",
      type: "string",
      placeholder: "<slug>",
      description: "Only models from this company, like openai",
    },
  ],
  examples: [
    "opensume models",
    "opensume models --kind video",
    "opensume models seedance",
    "opensume models gpt-image-2",
  ],
  run: modelsCommand,
};

async function modelsCommand(parsed: Parsed, ctx: Context): Promise<number> {
  const { ui } = ctx;
  const query = parsed.args[0]?.trim();
  const kind = parsed.flags.kind as string | undefined;
  const company = (parsed.flags.company as string | undefined)?.toLowerCase();

  ui.spin("Loading models");
  const all = await ctx.client().listModels(ctx.signal);
  ui.stopSpinner();

  const exact = query ? all.find((m) => m.id === query || m.slug === query) : undefined;
  if (exact) {
    if (ctx.json) ui.json(exact);
    else renderModel(ctx, exact);
    return ExitCode.Ok;
  }

  const needle = query?.toLowerCase();
  const list = all.filter(
    (m) =>
      (!kind || m.kind === kind) &&
      (!company || m.company.slug.toLowerCase() === company || m.company.name.toLowerCase() === company) &&
      (!needle ||
        [m.id, m.name, m.company.name, m.company.slug, m.kind, ...(m.modes ?? [])].some((v) =>
          v.toLowerCase().includes(needle),
        )),
  );

  if (ctx.json) {
    ui.json(list);
    return ExitCode.Ok;
  }
  if (list.length === 0) {
    const guess = query
      ? closest(
          query,
          all.map((m) => m.id),
        )
      : undefined;
    ui.error(
      `No models match${query ? ` "${query}"` : ""}${kind ? ` (kind ${kind})` : ""}${company ? ` (company ${company})` : ""}.`,
      guess ? `Did you mean ${guess}?` : "Run `opensume models` to see them all.",
    );
    return ExitCode.Ok;
  }
  const { c } = ui;
  ui.table(
    ["MODEL", "KIND", "COMPANY", "FROM", "INPUTS"],
    list.map((m) => [c.bold(m.id), m.kind, m.company.name, fromPrice(m), inputs(m)]),
  );
  ui.info(c.dim(`\n${list.length} model${list.length === 1 ? "" : "s"}. Details: opensume models <id>`));
  return ExitCode.Ok;
}

const UNIT: Record<string, string> = { second: "/s", image: "/image", request: "/request" };

/** `text-to-video, image-to-video` → `text, image`: what a model starts from. */
export function inputs(m: Pick<CatalogModel, "modes">): string {
  const words = (m.modes ?? []).map((mode) => {
    if (mode === "image-edit") return "image";
    if (mode === "video-captions") return "video";
    return mode.split("-to-")[0] ?? mode;
  });
  return [...new Set(words)].join(", ");
}

function fromPrice(m: CatalogModel): string {
  return `${formatUsd(m.pricing.from_usd)}${UNIT[m.pricing.unit] ?? `/${m.pricing.unit}`}`;
}

const CAPABILITY_LABELS: Record<string, string> = {
  text_to_image: "text to image",
  image_edit: "image edit",
  text_to_video: "text to video",
  image_to_video: "image to video",
  end_frame: "end frame",
  reference_images: "reference images",
  reference_videos: "reference videos",
  reference_audios: "reference audio",
  video_to_video: "video to video",
  audio: "audio",
  lipsync: "lip-sync",
  captions: "captions",
};

const RANGE_UNITS: Record<string, string> = { duration_seconds: " s" };
const FIELD_LABELS: Record<string, string> = {
  duration_seconds: "Duration",
  duration_values: "Durations",
  aspect_ratios: "Aspect ratios",
  max_images: "Max images",
  output_formats: "Formats",
};

function renderModel(ctx: Context, m: CatalogModel): void {
  const { ui } = ctx;
  const { c } = ui;
  const width = Math.min(ui.width, 100);
  const rows: [string, string][] = [];
  const caps = m.capabilities ?? {};
  const unit = m.pricing.unit === "second" ? "/s" : `/${m.pricing.unit}`;

  rows.push(["Kind", m.kind]);
  if (m.modes?.length) rows.push(["Modes", m.modes.join(", ")]);
  rows.push(["Price", `${m.pricing.qualifier === "from" ? "from " : ""}${formatUsd(m.pricing.from_usd)}${unit}`]);
  const supports = Object.entries(caps)
    .filter(([, v]) => v === true)
    .map(([k]) => CAPABILITY_LABELS[k] ?? k.replaceAll("_", " "));
  if (supports.length) rows.push(["Takes", supports.join(", ")]);
  for (const [key, value] of Object.entries(caps)) {
    if (typeof value === "boolean") continue;
    const label = FIELD_LABELS[key] ?? key.replaceAll("_", " ").replace(/^./u, (ch) => ch.toUpperCase());
    if (Array.isArray(value)) {
      if (value.length) rows.push([label, value.join(", ")]);
    } else if (value && typeof value === "object" && "min" in value && "max" in value) {
      const range = value as { min: number; max: number };
      rows.push([label, `${range.min}–${range.max}${RANGE_UNITS[key] ?? ""}`]);
    } else if (value !== null && value !== undefined) {
      rows.push([label, String(value)]);
    }
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
  ui.out(`${c.bold(m.id)} ${c.dim("—")} ${m.name} ${c.dim(`(${m.company.name})`)}`);
  if (m.description) for (const line of wrap(m.description, width)) ui.out(c.dim(line));
  ui.out();
  for (const [label, value] of rows) {
    const [first, ...rest] = wrap(value, width - labelWidth);
    ui.out(`${c.dim(label.padEnd(labelWidth))}${first ?? ""}`);
    for (const line of rest) ui.out(`${" ".repeat(labelWidth)}${line}`);
    if (label === "Price") {
      const options = m.pricing.options ?? [];
      if (options.length > 1) {
        const optionWidth = Math.max(...options.map((o) => o.label.length));
        for (const o of options) {
          ui.out(`${" ".repeat(labelWidth)}${c.dim(o.label.padEnd(optionWidth))}  ${formatUsd(o.usd)}${unit}`);
        }
      }
    }
  }

  if (m.constraints?.length) {
    ui.out();
    ui.out(c.bold("Notes"));
    for (const note of m.constraints) {
      const [first, ...rest] = wrap(note, width - 4);
      ui.out(`  ${c.dim("•")} ${first ?? ""}`);
      for (const line of rest) ui.out(`    ${line}`);
    }
  }

  ui.out();
  ui.out(c.bold("Try it"));
  ui.out(`  ${c.dim("$")} ${example(m)}`);
}

function example(m: CatalogModel): string {
  const caps = (m.capabilities ?? {}) as Record<string, unknown>;
  switch (m.kind) {
    case "image": {
      const qualities = caps.qualities as string[] | undefined;
      const low = qualities?.includes("low") ? " -q low" : "";
      return caps.text_to_image === false
        ? `opensume run ${m.id} "what to change" --image ./photo.png`
        : `opensume run ${m.id} "a ceramic cup on a wooden table"${low}`;
    }
    case "lipsync":
      return caps.video_to_video
        ? `opensume run ${m.id} --video ./face.mp4 --audio ./speech.wav -d 6`
        : `opensume run ${m.id} --image ./face.png --audio ./speech.wav -d 6`;
    case "captions":
      return `opensume run ${m.id} --video ./clip.mp4 -d 12 --set captions.style=simple`;
    default: {
      const range = caps.duration_seconds as { min?: number } | undefined;
      const resolutions = caps.resolutions as string[] | undefined;
      const duration = range?.min ? ` -d ${Math.max(range.min, 4)}` : "";
      const resolution = resolutions?.length ? ` -r ${resolutions[0]}` : "";
      if (caps.text_to_video === false && caps.image_to_video) {
        return `opensume run ${m.id} "slow push in" --image ./first-frame.png${duration}${resolution}`;
      }
      if (caps.text_to_video === false) return `opensume models ${m.id}  # see Notes for its inputs`;
      return `opensume run ${m.id} "a paper boat drifting down a rain gutter"${duration}${resolution}`;
    }
  }
}
