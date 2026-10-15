import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Artifact } from "../src/api/types.ts";
import { planPaths, shortJobId } from "../src/lib/download.ts";
import { extensionFor } from "../src/lib/media.ts";

const artifact = (content_type: string, url = "https://media.sume.com/a/file"): Artifact => ({
  id: "artf_1",
  type: content_type.startsWith("video") ? "video" : "image",
  url,
  content_type,
});
const jobId = "job_7513b52d-3669-4ffe-b317-8b02000715eb";
const cwd = () => mkdtempSync(join(tmpdir(), "opensume-dl-"));

describe("planPaths", () => {
  it("names files after the model and job by default", async () => {
    const dir = cwd();
    expect(await planPaths([artifact("image/png")], { model: "gpt-image-2", jobId, cwd: dir })).toEqual([
      join(dir, "gpt-image-2-7513b52d.png"),
    ]);
  });

  it("numbers several files and never overwrites by default", async () => {
    const dir = cwd();
    writeFileSync(join(dir, "gpt-image-2-7513b52d-1.png"), "taken");
    const paths = await planPaths([artifact("image/png"), artifact("image/png")], {
      model: "gpt-image-2",
      jobId,
      cwd: dir,
    });
    expect(paths).toEqual([join(dir, "gpt-image-2-7513b52d-1-2.png"), join(dir, "gpt-image-2-7513b52d-2.png")]);
  });

  it("writes an explicit file name as given, numbering the rest", async () => {
    const dir = cwd();
    expect(await planPaths([artifact("video/mp4")], { output: "boat.mp4", model: "m", jobId, cwd: dir })).toEqual([
      join(dir, "boat.mp4"),
    ]);
    expect(
      await planPaths([artifact("image/png"), artifact("image/png")], { output: "cup", model: "m", jobId, cwd: dir }),
    ).toEqual([join(dir, "cup.png"), join(dir, "cup-2.png")]);
  });

  it("keeps each extra file's own extension next to a named file", async () => {
    const dir = cwd();
    expect(
      await planPaths([artifact("video/mp4"), artifact("image/jpeg")], {
        output: "boat.mp4",
        model: "m",
        jobId,
        cwd: dir,
      }),
    ).toEqual([join(dir, "boat.mp4"), join(dir, "boat-2.jpg")]);
  });

  it("saves into a directory when -o names one", async () => {
    const dir = cwd();
    mkdirSync(join(dir, "out"));
    expect(await planPaths([artifact("image/webp")], { output: "out", model: "m", jobId, cwd: dir })).toEqual([
      join(dir, "out", "m-7513b52d.webp"),
    ]);
    expect(await planPaths([artifact("image/png")], { output: "new/", model: "m", jobId, cwd: dir })).toEqual([
      join(dir, "new", "m-7513b52d.png"),
    ]);
  });
});

describe("extensions", () => {
  it("prefers the content type, then the URL, then the kind", () => {
    expect(extensionFor("image/jpeg")).toBe(".jpg");
    expect(extensionFor("application/octet-stream", "https://media.sume.com/x/video.mp4")).toBe(".mp4");
    expect(extensionFor(undefined, "https://media.sume.com/x/blob", "video")).toBe(".mp4");
    expect(extensionFor("application/x-unknown")).toBe(".bin");
  });

  it("shortens job ids", () => {
    expect(shortJobId(jobId)).toBe("7513b52d");
    expect(shortJobId("odd")).toBe("odd");
  });
});

describe("selectArtifacts", () => {
  it("keeps final outputs and drops posters, labelled or not", async () => {
    const { selectArtifacts } = await import("../src/commands/shared.ts");
    const video = { id: "v", type: "video", url: "https://x/v.mp4", content_type: "video/mp4" } as const;
    const labelled = {
      id: "p",
      type: "image",
      stage: "poster",
      url: "https://x/p.jpg",
      content_type: "image/jpeg",
    } as const;
    const bare = { id: "b", type: "image", url: "https://x/b.jpg", content_type: "image/jpeg" } as const;
    expect(selectArtifacts([video, labelled], false).map((a) => a.id)).toEqual(["v"]);
    expect(selectArtifacts([video, bare], false).map((a) => a.id)).toEqual(["v"]);
    expect(selectArtifacts([video, bare], true).map((a) => a.id)).toEqual(["v", "b"]);
    expect(selectArtifacts([bare, { ...bare, id: "c" }], false).map((a) => a.id)).toEqual(["b", "c"]);
  });
});

describe("templates", () => {
  it("names files from tokens, numbering and adding extensions when the template does not", async () => {
    const { checkTemplate } = await import("../src/lib/download.ts");
    const dir = cwd();
    const two = [artifact("image/png"), artifact("image/webp")];
    expect(
      await planPaths(two, { output: "out/{model}-{job}-{index}.{ext}", model: "gpt-image-2", jobId, cwd: dir }),
    ).toEqual([join(dir, "out", "gpt-image-2-7513b52d-1.png"), join(dir, "out", "gpt-image-2-7513b52d-2.webp")]);
    expect(await planPaths(two, { output: "{job_id}", model: "m", jobId, cwd: dir })).toEqual([
      join(dir, `${jobId}.png`),
      join(dir, `${jobId}-2.webp`),
    ]);
    expect(() => checkTemplate("out/{nope}.{ext}")).toThrow(/unknown token \{nope\}/u);
    expect(() => checkTemplate("plain.png")).not.toThrow();
  });
});
