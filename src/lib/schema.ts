import type { Router } from "../api/client.ts";
import { ROUTER_SCHEMAS } from "../generated/router-schemas.ts";
import { closest } from "./args.ts";
import { UsageError } from "./errors.ts";
import type { FieldSchema, RouterSchema } from "./schema-types.ts";

export function routerSchema(router: Router): RouterSchema {
  return ROUTER_SCHEMAS[router];
}

/** The CLI flag that fills each request field; anything else goes through `--set`. */
export const FIELD_FLAGS: Readonly<Record<string, string>> = {
  prompt: "[prompt], -p",
  image_urls: "-i, --image",
  input_urls: "-i, --image",
  image_url: "-i, --image",
  first_frame_url: "-i, --image",
  end_image_url: "--end-image",
  last_frame_url: "--end-image",
  video_url: "--video",
  audio_url: "--audio",
  reference_image_urls: "--ref-image",
  reference_video_urls: "--ref-video",
  reference_audio_urls: "--ref-audio",
  mask_url: "--mask",
  mask_image_url: "--mask",
  aspect_ratio: "-a, --aspect-ratio",
  resolution: "-r, --resolution",
  duration: "-d, --duration",
  duration_seconds: "-d, --duration",
  quality: "-q, --quality",
  num_images: "-n, --num-images",
  n: "-n, --num-images",
  output_format: "--format",
  format: "--format",
  image_size: "--size",
  background: "--background",
  generate_audio: "--[no-]generate-audio",
  webhook_url: "--webhook",
  model: "(the model argument)",
};

/** Fields the CLI sets itself; `--set` on them would only confuse things. */
const CLI_OWNED = new Set(["model", "mode", "wait_timeout_seconds"]);

export function fieldType(field: FieldSchema): string {
  if (field.oneOf) return field.oneOf.map(fieldType).join(" | ");
  if (field.enum) return field.enum.length <= 6 ? field.enum.join("|") : `${field.enum.slice(0, 5).join("|")}|…`;
  if (field.type === "array") {
    const item = field.items ? fieldType(field.items) : "any";
    const range =
      field.minItems !== undefined || field.maxItems !== undefined
        ? ` (${field.minItems ?? 0}–${field.maxItems ?? "∞"})`
        : "";
    return `${item.includes("|") ? `(${item})` : item}[]${range}`;
  }
  if (field.type === "string" && field.format === "uri") return "url";
  if (
    (field.type === "integer" || field.type === "number") &&
    (field.minimum !== undefined || field.maximum !== undefined)
  ) {
    return `${field.type} ${field.minimum ?? "…"}–${field.maximum ?? "…"}`;
  }
  return field.type ?? "any";
}

/**
 * Turn `--set key=value` text into the value the field takes, by the field's
 * own type: `prompt=1984` stays text, `num_images=2` becomes a number. A
 * field the schema does not know keeps the old rule (JSON when it parses).
 */
export function typedValue(
  field: FieldSchema | undefined,
  key: string,
  raw: string,
  guess: (raw: string) => unknown,
): unknown {
  if (!field) return guess(raw);
  const types = field.oneOf ? field.oneOf.map((f) => f.type) : [field.type];
  const trimmed = raw.trim();
  if (types.includes("string") && !types.some((t) => t === "object" || t === "array")) return raw;
  if (types.length === 1 && (types[0] === "integer" || types[0] === "number")) {
    const value = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(value) || (types[0] === "integer" && !Number.isInteger(value))) {
      throw new UsageError(
        `--set ${key} takes ${types[0] === "integer" ? "a whole number" : "a number"} (got "${raw}").`,
      );
    }
    return value;
  }
  if (types.length === 1 && types[0] === "boolean") {
    if (/^(true|yes|1)$/iu.test(trimmed)) return true;
    if (/^(false|no|0)$/iu.test(trimmed)) return false;
    throw new UsageError(`--set ${key} takes true or false (got "${raw}").`);
  }
  // Objects, arrays, or a string-or-object field like image_size: JSON when it is JSON.
  return guess(raw);
}

/** Look a dotted `--set` path up in the router's schema. */
export function fieldAt(router: Router, path: readonly string[]): FieldSchema | undefined {
  let field: FieldSchema | undefined = routerSchema(router).fields[path[0] as string];
  for (const part of path.slice(1)) {
    if (!field) return undefined;
    field = field.properties?.[part] ?? (field.type === "array" ? field.items?.properties?.[part] : undefined);
  }
  return field;
}

export function isCliOwned(key: string): boolean {
  return CLI_OWNED.has(key);
}

/**
 * Fields in a request body the router does not take, each with a "did you
 * mean". The API refuses them on submit, but the free estimate ignores them
 * and prices the request without them, so they are worth a warning first.
 */
export function unknownFields(router: Router, body: Record<string, unknown>): string[] {
  const schema = routerSchema(router);
  const names = Object.keys(schema.fields);
  const notes: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const field = schema.fields[key];
    if (!field) {
      const guess = closest(key, names);
      notes.push(`${key} is not a field of ${schema.endpoint}${guess ? `; did you mean ${guess}?` : "."}`);
      continue;
    }
    if (field.properties && value && typeof value === "object" && !Array.isArray(value)) {
      const inner = Object.keys(field.properties);
      for (const sub of Object.keys(value as Record<string, unknown>)) {
        if (!field.properties[sub]) {
          const guess = closest(sub, inner);
          notes.push(`${key}.${sub} is not a field of ${key}${guess ? `; did you mean ${key}.${guess}?` : "."}`);
        }
      }
    }
  }
  return notes;
}
