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
