import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Router } from "../api/client.ts";
import type { CatalogModel } from "../api/types.ts";
import { CliError, ExitCode, UsageError } from "./errors.ts";
import { isHttpUrl } from "./media.ts";
import { fieldAt, typedValue } from "./schema.ts";

/** What `run` and `estimate` read from the command line. */
export interface InputFlags {
  prompt?: string | undefined;
  image?: string[] | undefined;
  "end-image"?: string | undefined;
  video?: string | undefined;
  audio?: string | undefined;
  "ref-image"?: string[] | undefined;
  "ref-video"?: string[] | undefined;
  "ref-audio"?: string[] | undefined;
  mask?: string | undefined;
  "aspect-ratio"?: string | undefined;
  resolution?: string | undefined;
  duration?: number | undefined;
  quality?: string | undefined;
  "num-images"?: number | undefined;
  format?: string | undefined;
  size?: string | undefined;
  "generate-audio"?: boolean | undefined;
  background?: string | undefined;
  webhook?: string | undefined;
  set?: string[] | undefined;
  input?: string | undefined;
}

/** Request fields that carry media by URL. Local paths in them get uploaded. */
export const MEDIA_FIELDS = [
  "image_urls",
  "input_urls",
  "image_url",
  "first_frame_url",
  "end_image_url",
  "last_frame_url",
  "video_url",
  "audio_url",
  "reference_image_urls",
  "reference_video_urls",
  "reference_audio_urls",
  "mask_url",
  "mask_image_url",
] as const;

export function routerFor(model: Pick<CatalogModel, "kind">): Router {
  return model.kind === "image" ? "image" : "video";
}

const only = (router: Router, flag: string, model: CatalogModel) => {
  const wanted = router === "image" ? "image" : "video";
  return new UsageError(
    `--${flag} applies to ${wanted} models; ${model.id} is ${article(model.kind)} ${model.kind} model.`,
    `See what ${model.id} takes with \`opensume models ${model.id}\`.`,
  );
};

const article = (word: string) => (/^[aeiou]/iu.test(word) ? "an" : "a");

/**
 * Build the router request body. Precedence, lowest first: `--input` JSON,
 * the typed flags, then `--set key=value`. `model` is always the catalog id.
 */
export async function buildBody(
  model: CatalogModel,
  flags: InputFlags,
  stdin: () => Promise<string> = readStdin,
  cwd = process.cwd(),
): Promise<Record<string, unknown>> {
  const router = routerFor(model);
  const input = flags.input && flags.input !== "-" ? resolve(cwd, flags.input) : flags.input;
  const body: Record<string, unknown> = input ? await readInputJson(input, stdin, flags.input as string) : {};
  delete body.model;

  const set = (key: string, value: unknown) => {
    if (value !== undefined) body[key] = value;
  };
  const imageOnly = (flag: keyof InputFlags, key: string, value: unknown) => {
    if (value === undefined) return;
    if (router !== "image") throw only("image", flag, model);
    body[key] = value;
  };
  const videoOnly = (flag: keyof InputFlags, key: string, value: unknown) => {
    if (value === undefined) return;
    if (router !== "video") throw only("video", flag, model);
    body[key] = value;
  };

  set("prompt", flags.prompt);

  const images = flags.image ?? [];
  if (images.length > 0) {
    if (router === "image") {
      body.image_urls = images;
    } else if (images.length > 1) {
      throw new UsageError(
        "Video models take one --image (the first frame).",
        "Use --end-image for the last frame, or --ref-image for reference images.",
      );
    } else {
      body.image_url = images[0];
    }
  }
  videoOnly("end-image", "end_image_url", flags["end-image"]);
  videoOnly("video", "video_url", flags.video);
  videoOnly("audio", "audio_url", flags.audio);
  videoOnly("ref-image", "reference_image_urls", nonEmpty(flags["ref-image"]));
  videoOnly("ref-video", "reference_video_urls", nonEmpty(flags["ref-video"]));
  videoOnly("ref-audio", "reference_audio_urls", nonEmpty(flags["ref-audio"]));
  imageOnly("mask", "mask_url", flags.mask);

  set("aspect_ratio", flags["aspect-ratio"]);
  set("resolution", flags.resolution);
  if (flags.duration !== undefined && !Number.isInteger(flags.duration)) {
    throw new UsageError(`--duration takes whole seconds (got ${flags.duration}).`);
  }
  videoOnly("duration", "duration", flags.duration);
  imageOnly("quality", "quality", flags.quality);
  imageOnly("num-images", "num_images", flags["num-images"]);
  imageOnly("format", "output_format", flags.format);
  imageOnly("size", "image_size", flags.size);
  imageOnly("background", "background", flags.background);
  videoOnly("generate-audio", "generate_audio", flags["generate-audio"]);
  set("webhook_url", flags.webhook);

  for (const entry of flags.set ?? []) applySet(body, entry, router);
  delete body.model;
  // Lip-sync and captions are billed by the clip's length, which the API
  // requires up front; without it the price is refused with no hint why.
  if (
    (model.kind === "lipsync" || model.kind === "captions") &&
    body.duration === undefined &&
    body.duration_seconds === undefined
  ) {
    throw new UsageError(
      `${model.id} needs --duration: the clip's length in whole seconds${model.kind === "lipsync" ? " (the audio's, for a photo)" : ""}.`,
    );
  }
  return body;
}

const nonEmpty = (list: string[] | undefined) => (list && list.length > 0 ? list : undefined);

/**
 * `key=value`, where the value is JSON when it parses as JSON (numbers,
 * booleans, arrays, objects) and a string otherwise. `a.b=1` sets a nested
 * field; `key[]=value` appends to a list.
 */
export function applySet(body: Record<string, unknown>, entry: string, router?: Router): void {
  const eq = entry.indexOf("=");
  if (eq <= 0) throw new UsageError(`--set takes key=value (got "${entry}").`);
  let key = entry.slice(0, eq).trim();
  const raw = entry.slice(eq + 1);
  const append = key.endsWith("[]");
  if (append) key = key.slice(0, -2);
  const path = key.split(".");
  if (path.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) {
    throw new UsageError(`--set key "${key}" may use letters, digits, "_" and "-", with "." between levels.`);
  }
  if (path.includes("__proto__") || path.includes("constructor") || path.includes("prototype")) {
    throw new UsageError(`--set key "${key}" is not allowed.`);
  }
  if (path.length === 1 && path[0] === "model") {
    throw new UsageError("--set cannot change the model; it is the first argument of the command.");
  }
  // With the router known, the field's own type decides: `prompt=1984` stays text.
  const value = router ? typedValue(fieldAt(router, path), key, raw, parseValue) : parseValue(raw);
  let target = body;
  for (const part of path.slice(0, -1)) {
    const next = target[part];
    if (next === undefined) target[part] = {};
    else if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new UsageError(`--set ${key}: "${part}" is already set to a non-object value.`);
    }
    target = target[part] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1] as string;
  if (append) {
    const current = target[leaf];
    target[leaf] = Array.isArray(current) ? [...current, value] : current === undefined ? [value] : [current, value];
  } else {
    target[leaf] = value;
  }
}

export function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (/^-?\d+$/u.test(trimmed) && !Number.isSafeInteger(Number(trimmed))) return trimmed;
  if (/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/u.test(trimmed) || /^[[{"]/u.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return raw;
}

async function readInputJson(
  path: string,
  stdin: () => Promise<string>,
  source = path,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = path === "-" ? await stdin() : await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof CliError) throw cause;
    const code = (cause as NodeJS.ErrnoException).code;
    const why =
      code === "ENOENT"
        ? "no such file"
        : code === "EISDIR"
          ? "it is a folder"
          : code === "EACCES"
            ? "permission denied"
            : (code ?? "error");
    throw new CliError(`Cannot read --input ${source}: ${why}.`, {
      exitCode: ExitCode.Usage,
      code: "input_unreadable",
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CliError(`--input ${source} is not valid JSON: ${(cause as Error).message}.`, {
      exitCode: ExitCode.Usage,
      code: "input_invalid",
      cause,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`--input ${source} must be a JSON object (the request body).`, {
      exitCode: ExitCode.Usage,
      code: "input_invalid",
    });
  }
  return parsed as Record<string, unknown>;
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError("--input - reads JSON from stdin, but stdin is a terminal.");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Every string in the body's media fields: URLs and local paths alike. */
export function mediaValues(body: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const field of MEDIA_FIELDS) {
    const value = body[field];
    for (const item of Array.isArray(value) ? value : [value]) if (typeof item === "string" && item) values.push(item);
  }
  return values;
}

/** Every local file path in the body's media fields, in order, deduplicated. */
export function localMediaPaths(body: Record<string, unknown>): string[] {
  return [...new Set(mediaValues(body).filter((item) => !isHttpUrl(item)))];
}

/** Swap local paths for the URLs they were uploaded to. */
export function replaceMedia(body: Record<string, unknown>, urls: ReadonlyMap<string, string>): void {
  for (const field of MEDIA_FIELDS) {
    const value = body[field];
    if (typeof value === "string") body[field] = urls.get(value) ?? value;
    else if (Array.isArray(value)) body[field] = value.map((v) => (typeof v === "string" ? (urls.get(v) ?? v) : v));
  }
}
