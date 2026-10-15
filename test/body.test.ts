import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../src/api/types.ts";
import { applySet, buildBody, localMediaPaths, parseValue, replaceMedia, routerFor } from "../src/lib/body.ts";

const model = (id: string, kind: CatalogModel["kind"]) => ({ id, kind }) as CatalogModel;
const image = model("gpt-image-2", "image");
const video = model("seedance-2-mini", "video");
const lipsync = model("veed-lipsync", "lipsync");

describe("routerFor", () => {
  it("sends images to the image router and everything else to the video router", () => {
    expect(routerFor(image)).toBe("image");
    expect(routerFor(video)).toBe("video");
    expect(routerFor(lipsync)).toBe("video");
    expect(routerFor(model("veed-subtitles", "captions"))).toBe("video");
  });
});

describe("buildBody", () => {
  it("maps image flags to Image Router fields", async () => {
    const body = await buildBody(image, {
      prompt: "a cup",
      image: ["https://x/a.png", "https://x/b.png"],
      quality: "low",
      "num-images": 2,
      format: "webp",
      size: "1024x1536",
      "aspect-ratio": "1:1",
    });
    expect(body).toEqual({
      prompt: "a cup",
      image_urls: ["https://x/a.png", "https://x/b.png"],
      quality: "low",
      num_images: 2,
      output_format: "webp",
      image_size: "1024x1536",
      aspect_ratio: "1:1",
    });
  });

  it("maps video flags to Video Router fields", async () => {
    const body = await buildBody(video, {
      prompt: "a boat",
      image: ["https://x/first.png"],
      "end-image": "https://x/last.png",
      "ref-image": ["https://x/r.png"],
      duration: 4,
      resolution: "480p",
      "generate-audio": false,
    });
    expect(body).toEqual({
      prompt: "a boat",
      image_url: "https://x/first.png",
      end_image_url: "https://x/last.png",
      reference_image_urls: ["https://x/r.png"],
      duration: 4,
      resolution: "480p",
      generate_audio: false,
    });
  });

  it("refuses flags the model's router does not take", async () => {
    await expect(buildBody(image, { prompt: "x", duration: 4 })).rejects.toThrow(
      "--duration applies to video models; gpt-image-2 is an image model.",
    );
    await expect(buildBody(video, { prompt: "x", quality: "low" })).rejects.toThrow(
      /--quality applies to image models/u,
    );
    await expect(buildBody(video, { image: ["a", "b"] })).rejects.toThrow(/one --image/u);
    await expect(buildBody(video, { duration: 4.5 })).rejects.toThrow(/whole seconds/u);
  });

  it("layers --input, then flags, then --set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensume-body-"));
    const file = join(dir, "body.json");
    writeFileSync(file, JSON.stringify({ model: "ignored", prompt: "from file", resolution: "720p", duration: 8 }));
    const body = await buildBody(video, { input: file, duration: 4, set: ["resolution=480p", "captions.style=glass"] });
    expect(body).toEqual({ prompt: "from file", resolution: "480p", duration: 4, captions: { style: "glass" } });
  });

  it("asks for --duration on lip-sync and captions models", async () => {
    await expect(buildBody(lipsync, { video: "https://x/a.mp4", audio: "https://x/a.wav" })).rejects.toThrow(
      "veed-lipsync needs --duration",
    );
    await expect(
      buildBody(lipsync, { video: "https://x/a.mp4", audio: "https://x/a.wav", duration: 6 }),
    ).resolves.toMatchObject({
      duration: 6,
    });
  });

  it("reads --input - from stdin", async () => {
    const body = await buildBody(image, { input: "-" }, async () => '{"prompt":"piped"}');
    expect(body).toEqual({ prompt: "piped" });
  });

  it("rejects --input that is not a JSON object", async () => {
    await expect(buildBody(image, { input: "-" }, async () => "[1,2]")).rejects.toThrow(/must be a JSON object/u);
    await expect(buildBody(image, { input: "-" }, async () => "{nope")).rejects.toThrow(/not valid JSON/u);
  });
});

describe("--set", () => {
  it("parses JSON values and keeps everything else as text", () => {
    expect(parseValue("4")).toBe(4);
    expect(parseValue("true")).toBe(true);
    expect(parseValue('["a","b"]')).toEqual(["a", "b"]);
    expect(parseValue("007")).toBe("007");
    expect(parseValue("glass")).toBe("glass");
    expect(parseValue("{broken")).toBe("{broken");
  });

  it("nests on dots and appends on []", () => {
    const body: Record<string, unknown> = {};
    applySet(body, "captions.style=glass");
    applySet(body, "captions.position=bottom");
    applySet(body, "reference_image_urls[]=https://x/1.png");
    applySet(body, "reference_image_urls[]=https://x/2.png");
    expect(body).toEqual({
      captions: { style: "glass", position: "bottom" },
      reference_image_urls: ["https://x/1.png", "https://x/2.png"],
    });
  });

  it("refuses malformed and dangerous keys", () => {
    expect(() => applySet({}, "novalue")).toThrow(/key=value/u);
    expect(() => applySet({}, "__proto__.polluted=1")).toThrow(/not allowed/u);
    expect(() => applySet({}, "a b=1")).toThrow(/may use letters/u);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("local media", () => {
  it("finds local paths in media fields and swaps in uploaded URLs", () => {
    const body: Record<string, unknown> = {
      prompt: "./not-media.png",
      image_urls: ["./a.png", "https://x/b.png", "./a.png"],
      video_url: "clip.mp4",
      audio_url: "https://x/line.wav",
    };
    expect(localMediaPaths(body)).toEqual(["./a.png", "clip.mp4"]);
    replaceMedia(
      body,
      new Map([
        ["./a.png", "https://media/a.png"],
        ["clip.mp4", "https://media/clip.mp4"],
      ]),
    );
    expect(body).toEqual({
      prompt: "./not-media.png",
      image_urls: ["https://media/a.png", "https://x/b.png", "https://media/a.png"],
      video_url: "https://media/clip.mp4",
      audio_url: "https://x/line.wav",
    });
  });
});
