import { describe, expect, it } from "vitest";
import { modelFields } from "../src/lib/model-fields.ts";
import { routerSchema } from "../src/lib/schema.ts";

const video = routerSchema("video").fields;
const image = routerSchema("image").fields;

describe("modelFields: one model's inputs from its catalog row", () => {
  it("drops what a text/image-to-video model does not take and narrows its limits", () => {
    const fields = modelFields(
      "video",
      "seedance-1.5-pro",
      {
        text_to_video: true,
        image_to_video: true,
        end_frame: false,
        reference_images: false,
        reference_videos: false,
        reference_audios: false,
        video_to_video: false,
        audio: true,
        resolutions: ["480p", "720p", "1080p"],
        duration_seconds: { min: 4, max: 12 },
        aspect_ratios: ["16:9", "1:1"],
      },
      video,
    );
    for (const gone of ["video_url", "audio_url", "captions", "end_image_url", "reference_image_urls", "task"])
      expect(fields[gone], gone).toBeUndefined();
    expect(fields.image_url).toBeDefined();
    expect(fields.generate_audio).toBeDefined();
    expect(fields.resolution?.enum).toEqual(["480p", "720p", "1080p"]);
    expect(fields.aspect_ratio?.enum).toEqual(["16:9", "1:1"]);
    expect([fields.duration?.minimum, fields.duration?.maximum]).toEqual([4, 12]);
  });

  it("keeps a lipsync model to its source, speech and length", () => {
    const fields = modelFields(
      "video",
      "kling-lipsync",
      {
        video_to_video: true,
        lipsync: true,
        audio: true,
        resolutions: [],
        aspect_ratios: [],
        duration_seconds: { min: 2, max: 10 },
      },
      video,
    );
    expect(fields.video_url).toBeDefined();
    expect(fields.audio_url).toBeDefined();
    for (const gone of ["prompt", "image_url", "generate_audio", "resolution", "aspect_ratio"])
      expect(fields[gone], gone).toBeUndefined();
  });

  it("narrows an image model's choices and image count", () => {
    const fields = modelFields(
      "image",
      "gpt-image-2",
      {
        text_to_image: true,
        image_edit: true,
        aspect_ratios: ["1:1", "16:9"],
        resolutions: [],
        qualities: ["low", "medium", "high"],
        max_images: 4,
        output_formats: ["png"],
      },
      image,
    );
    expect(fields.quality?.enum).toEqual(["low", "medium", "high"]);
    expect(fields.resolution).toBeUndefined();
    expect(fields.output_format?.enum).toEqual(["png"]);
    expect(fields.num_images?.maximum).toBe(4);
    expect(fields.image_urls).toBeDefined();
    const textOnly = modelFields("image", "x", { text_to_image: true, image_edit: false, max_images: 1 }, image);
    expect(textOnly.image_urls).toBeUndefined();
    expect(textOnly.num_images).toBeUndefined();
  });

  it("keeps the whole endpoint when the catalog row is not known", () => {
    expect(Object.keys(modelFields("video", "x", undefined, video))).toEqual(Object.keys(video));
  });
});
