import type { Router } from "../api/client.ts";
import type { FieldSchema } from "./schema-types.ts";

type Caps = Readonly<Record<string, unknown>>;

const list = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

const flag = (caps: Caps, name: string) => caps[name] === true;

/**
 * One model's inputs, from its catalog row's `capabilities` (the same row the API checks a request
 * against). The vendored schema is the whole router's: every field any model takes, with the
 * router's widest limits. Here a field the model does not take is dropped, and a choice or a limit
 * the catalog gives is narrowed to the model's (`resolution`, `aspect_ratio`, `quality`,
 * `output_format`, `duration`, `num_images`). A field the catalog says nothing about is kept as is.
 * The mapping is the one the open.sume.com playground builds its form with.
 */
export function modelFields(
  router: Router,
  modelId: string,
  capabilities: Caps | undefined,
  fields: Readonly<Record<string, FieldSchema>>,
): Record<string, FieldSchema> {
  if (!capabilities) return { ...fields };
  const keep = router === "video" ? videoKeep(modelId, capabilities) : imageKeep(capabilities);
  const out: Record<string, FieldSchema> = {};
  for (const [name, field] of Object.entries(fields)) {
    const narrowed = keep(name, field);
    if (narrowed) out[name] = narrowed;
  }
  return out;
}

/** An enum narrowed to the catalog's list; dropped when the catalog lists none. */
function choices(field: FieldSchema, values: string[] | undefined): FieldSchema | null {
  if (values === undefined) return field;
  if (values.length === 0) return null;
  return { ...field, enum: values };
}

function videoKeep(modelId: string, c: Caps) {
  const lipsync = flag(c, "lipsync");
  const captions = flag(c, "captions");
  const v2v = flag(c, "video_to_video");
  const duration = c.duration_seconds as { min?: number; max?: number } | undefined;
  const durationValues = Array.isArray(c.duration_values)
    ? (c.duration_values as unknown[]).filter((v): v is number => typeof v === "number")
    : undefined;
  return (name: string, field: FieldSchema): FieldSchema | null => {
    switch (name) {
      case "prompt":
        return lipsync || captions ? null : field;
      case "task":
        return modelId.startsWith("auto-") ? field : null;
      case "image_url":
      case "first_frame_url":
        return (lipsync && !v2v) || (!lipsync && !captions && flag(c, "image_to_video")) ? field : null;
      case "end_image_url":
      case "last_frame_url":
        return flag(c, "end_frame") ? field : null;
      case "reference_image_urls":
        return flag(c, "reference_images") && !lipsync ? field : null;
      case "reference_video_urls":
        return flag(c, "reference_videos") && !v2v ? field : null;
      case "reference_audio_urls":
        return flag(c, "reference_audios") ? field : null;
      case "video_url":
        return v2v || captions ? field : null;
      case "audio_url":
        return lipsync ? field : null;
      case "captions":
        return captions ? field : null;
      case "generate_audio":
        return flag(c, "audio") && !lipsync && !captions ? field : null;
      case "resolution":
        return choices(field, list(c.resolutions));
      case "aspect_ratio":
        return choices(field, list(c.aspect_ratios));
      case "duration":
      case "duration_seconds":
        if (durationValues?.length) {
          const { minimum: _min, maximum: _max, ...rest } = field;
          return { ...rest, enum: durationValues };
        }
        if (duration && typeof duration.min === "number" && typeof duration.max === "number")
          return { ...field, minimum: duration.min, maximum: duration.max };
        return field;
      default:
        return field;
    }
  };
}

function imageKeep(c: Caps) {
  const edit = flag(c, "image_edit");
  const maxImages = typeof c.max_images === "number" ? c.max_images : undefined;
  return (name: string, field: FieldSchema): FieldSchema | null => {
    switch (name) {
      case "image_urls":
      case "input_urls":
      case "mask_url":
      case "mask_image_url":
        return edit ? field : null;
      case "aspect_ratio":
        return choices(field, list(c.aspect_ratios));
      case "resolution":
        return choices(field, list(c.resolutions));
      case "quality":
        return choices(field, list(c.qualities));
      case "output_format":
      case "format":
        return choices(field, list(c.output_formats));
      case "num_images":
      case "n":
        if (maxImages === undefined) return field;
        return maxImages <= 1 ? null : { ...field, minimum: 1, maximum: maxImages };
      default:
        return field;
    }
  };
}
