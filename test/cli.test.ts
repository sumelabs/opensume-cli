import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockApi, PNG, TEST_KEY } from "./helpers/mock-api.ts";
import { runCli, tempDir } from "./helpers/run-cli.ts";

let api: MockApi;
const cli = (args: string[], options: Parameters<typeof runCli>[1] = {}) =>
  runCli(args, { baseUrl: api.url, key: TEST_KEY, ...options });

beforeAll(async () => {
  api = await new MockApi().start();
});
afterAll(async () => {
  await api.stop();
});
beforeEach(() => {
  api.requests.length = 0;
  api.nextOutcome = "completed";
  api.nextArtifacts = 1;
  api.nextPoster = false;
  api.readsUntilDone = 2;
  api.balanceUsd = 10;
  api.failNextSubmits = { count: 0, status: 503, code: "database_busy" };
});

describe("run", () => {
  it("submits, waits and saves the file", async () => {
    const cwd = tempDir();
    const res = await cli(["run", "gpt-image-2", "a ceramic cup", "-q", "low"], { cwd });
    expect(res.code).toBe(0);
    const [submit] = api.calls("POST", "/v1/image-router/generate");
    expect(submit?.body).toEqual({ model: "gpt-image-2", prompt: "a ceramic cup", quality: "low" });
    expect(submit?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(submit?.headers["user-agent"]).toMatch(/^opensume-cli\//u);
    const saved = res.stdout.trim();
    expect(saved).toMatch(/gpt-image-2-[0-9a-f]{8}\.png$/u);
    expect(readFileSync(saved)).toEqual(PNG);
    expect(res.stderr).toContain("gpt-image-2 completed in");
    expect(res.stderr).toContain("$0.0077");
  });

  it("prints one JSON document with --json", async () => {
    const cwd = tempDir();
    const res = await cli(["run", "gpt-image-2", "a cup", "-o", "cup.png", "--json"], { cwd });
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
    const out = res.json<{ job: { status: string }; usd: string; artifacts: { path: string; bytes: number }[] }>();
    expect(out.job.status).toBe("completed");
    expect(out.usd).toBe("0.0077");
    expect(out.artifacts[0]?.path).toBe(join(cwd, "cup.png"));
    expect(out.artifacts[0]?.bytes).toBe(PNG.length);
  });

  it("saves the final output and skips intermediate files unless asked", async () => {
    api.nextPoster = true;
    const cwd = tempDir();
    const res = await cli(["run", "seedance-2-mini", "a boat", "-d", "4", "-o", "boat.mp4", "--json"], { cwd });
    const out = res.json<{ artifacts: { stage?: string; path?: string }[] }>();
    expect(out.artifacts).toHaveLength(2);
    expect(out.artifacts.filter((a) => a.path).map((a) => a.path)).toEqual([join(cwd, "boat.mp4")]);

    const all = await cli(["run", "seedance-2-mini", "a boat", "-d", "4", "-o", "out/", "--all-files", "--json"], {
      cwd,
    });
    expect(all.json<{ artifacts: { path?: string }[] }>().artifacts.every((a) => a.path)).toBe(true);
  });

  it("routes video, lip-sync and captions models to the video router", async () => {
    const res = await cli(["run", "seedance-2-mini", "a boat", "-d", "4", "-r", "480p", "--no-download"]);
    expect(res.code).toBe(0);
    expect(api.calls("POST", "/v1/video-router/generate")[0]?.body).toEqual({
      model: "seedance-2-mini",
      prompt: "a boat",
      duration: 4,
      resolution: "480p",
    });
    expect(res.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/media\/job_.*\.png\n$/u);
  });

  it("uploads local files first, without sending the key to storage", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "talk.png"), PNG);
    const res = await cli(
      ["run", "veed-lipsync", "--video", "talk.png", "--audio", "https://x.example/line.wav", "-d", "6"],
      { cwd },
    );
    expect(res.code).toBe(0);
    const put = api.calls("PUT", "/storage/")[0];
    expect(put?.headers.authorization).toBeUndefined();
    const body = api.calls("POST", "/v1/video-router/generate")[0]?.body as Record<string, string>;
    expect(body.video_url).toMatch(/\/media\/asset_\w+\.png$/u);
    expect(body.audio_url).toBe("https://x.example/line.wav");
  });

  it("returns at once with --no-wait", async () => {
    const res = await cli(["run", "gpt-image-2", "a cup", "--no-wait", "--json"]);
    expect(res.code).toBe(0);
    const out = res.json<{ job: { id: string }; status_url: string }>();
    expect(out.job.id).toMatch(/^job_/u);
    expect(api.calls("GET", "/v1/jobs/")).toHaveLength(0);
  });

  it("shows the request and price on --dry-run, and submits nothing", async () => {
    const res = await cli(["run", "seedance-2-mini", "a boat", "-d", "4", "--dry-run", "--json"]);
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({
      model: "seedance-2-mini",
      router: "video",
      body: { prompt: "a boat", duration: 4 },
    });
    expect(api.calls("POST", "/v1/video-router/generate")).toHaveLength(0);
  });

  it("refuses to go over --max-usd", async () => {
    const res = await cli(["run", "seedance-2-mini", "a boat", "-d", "10", "--max-usd", "0.5"]);
    expect(res.code).toBe(7);
    expect(res.stderr).toContain("over --max-usd $0.50");
    expect(api.calls("POST", "/v1/video-router/generate")).toHaveLength(0);
  });

  it("retries a failed submit with the same idempotency key", async () => {
    api.failNextSubmits = { count: 2, status: 503, code: "database_busy" };
    const res = await cli(["run", "gpt-image-2", "a cup", "--no-download"]);
    expect(res.code).toBe(0);
    const submits = api.calls("POST", "/v1/image-router/generate");
    expect(submits).toHaveLength(3);
    expect(new Set(submits.map((s) => s.headers["idempotency-key"])).size).toBe(1);
  });

  it("follows the original job when an idempotency key is reused", async () => {
    const first = await cli([
      "run",
      "gpt-image-2",
      "a cup",
      "--idempotency-key",
      "same-key",
      "--json",
      "--no-download",
    ]);
    const second = await cli([
      "run",
      "gpt-image-2",
      "a cup",
      "--idempotency-key",
      "same-key",
      "--json",
      "--no-download",
    ]);
    expect(first.json<{ job: { id: string } }>().job.id).toBe(second.json<{ job: { id: string } }>().job.id);
  });

  it("exits 5 with the reason when the job fails", async () => {
    api.nextOutcome = "failed";
    const res = await cli(["run", "gpt-image-2", "a cup"]);
    expect(res.code).toBe(5);
    expect(res.stderr).toContain("gpt-image-2 failed: The model refused the prompt.");
    expect(res.stderr).toContain("opensume jobs events job_");
  });

  it("exits 6 when --timeout passes, naming the job to resume", async () => {
    api.readsUntilDone = 1000;
    const res = await cli(["run", "gpt-image-2", "a cup", "--timeout", "1ms"]);
    expect(res.code).toBe(6);
    expect(res.stderr).toMatch(/opensume jobs wait job_/u);
  });

  it("names the job to resume when interrupted", async () => {
    api.readsUntilDone = 1000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const res = await cli(["run", "gpt-image-2", "a cup"], { signal: controller.signal });
    expect(res.code).toBe(130);
    expect(res.stderr).toMatch(
      /Stopped waiting\. Job (job_\S+) keeps running on Sume\.\n {2}Pick it up with: opensume jobs wait \1/u,
    );
  });

  it("exits 3 without a valid key, before spending anything", async () => {
    expect((await cli(["run", "gpt-image-2", "a cup"], { key: null })).code).toBe(3);
    const wrong = await cli(["run", "gpt-image-2", "a cup"], { key: "sume_live_wrong" });
    expect(wrong.code).toBe(3);
    expect(wrong.stderr).toContain("Missing or invalid API key.");
  });

  it("exits 7 on insufficient funds, with the amounts", async () => {
    api.balanceUsd = 0;
    const res = await cli(["run", "gpt-image-2", "a cup"]);
    expect(res.code).toBe(7);
    expect(res.stderr).toContain("needs $0.0077, balance $0.00");
  });

  it("explains an unknown model with a suggestion", async () => {
    const res = await cli(["run", "gpt-image2", "a cup"]);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("Did you mean gpt-image-2?");
  });

  it("reports errors as JSON in --json mode", async () => {
    const res = await cli(["run", "gpt-image2", "a cup", "--json"]);
    expect(res.code).toBe(4);
    expect(res.json()).toMatchObject({ error: { code: "model_not_found" } });
  });
});

describe("jobs", () => {
  it("lists, shows, waits for and explains jobs", async () => {
    const submitted = await cli(["run", "gpt-image-2", "a cup", "--no-wait", "--json"]);
    const id = submitted.json<{ job: { id: string } }>().job.id;

    const list = await cli(["jobs", "list", "--json"]);
    expect(list.json<{ jobs: { id: string }[] }>().jobs.map((j) => j.id)).toContain(id);

    const cwd = tempDir();
    const waited = await cli(["jobs", "wait", id, "-o", "out/"], { cwd });
    expect(waited.code).toBe(0);
    expect(existsSync(join(cwd, "out"))).toBe(true);

    const got = await cli(["jobs", "get", id]);
    expect(got.stdout).toContain("completed");

    const events = await cli(["jobs", "events", id]);
    expect(events.stdout).toContain("job.completed");

    const cancel = await cli(["jobs", "cancel", id]);
    expect(cancel.code).toBe(4);
    expect(cancel.stderr).toContain("can only be canceled before generation starts");
  });

  it("cancels a queued job", async () => {
    const submitted = await cli(["run", "gpt-image-2", "a cup", "--no-wait", "--json"]);
    const id = submitted.json<{ job: { id: string } }>().job.id;
    const res = await cli(["jobs", "cancel", id, "--json"]);
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({ canceled: true });
  });

  it("answers 404 for a job that is not yours", async () => {
    const res = await cli(["jobs", "status", "job_missing"]);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("API job was not found.");
  });
});

describe("models and prices", () => {
  it("lists and filters models without a key", async () => {
    const res = await cli(["models", "--kind", "video"], { key: null });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("seedance-2-mini");
    expect(res.stdout).not.toContain("gpt-image-2");
  });

  it("shows one model", async () => {
    const res = await cli(["models", "gpt-image-2"], { key: null });
    expect(res.stdout).toContain("ChatGPT Image 2");
    expect(res.stdout).toContain("low   $0.0077/image");
    expect(res.stdout).toContain('opensume run gpt-image-2 "a ceramic cup on a wooden table" -q low');
  });

  it("warns when the price is for something other than what was asked", async () => {
    const { pricingNotes } = await import("../src/commands/shared.ts");
    const estimate = {
      model: "m",
      currency: "USD",
      usd: "1",
      usd_micros: 1,
      billing: { duration_seconds: 15, resolution: "720p" },
    };
    expect(pricingNotes({ duration: 99, resolution: "1080p" }, estimate)).toEqual([
      "Priced for 15s, not the 99s asked. Check the model's limits: opensume models m",
      "Priced at 720p, not the 1080p asked.",
    ]);
    expect(pricingNotes({ duration: 15, resolution: "720P" }, estimate)).toEqual([]);
  });

  it("prices a request without a key, and without uploading local files", async () => {
    const res = await cli(["estimate", "seedance-2-mini", "-d", "4", "--image", "./missing.png", "--json"], {
      key: null,
    });
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({ usd: "0.3516" });
    const sent = api.calls("POST", "/v1/open/estimate")[0]?.body as { input: { image_url: string } };
    expect(sent.input.image_url).toBe("https://upload.invalid/missing.png");
    expect(api.calls("POST", "/v1/assets/upload-url")).toHaveLength(0);
  });
});

describe("upload", () => {
  it("prints a media URL per file", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "a.png"), PNG);
    const res = await cli(["upload", "a.png"], { cwd });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/\/media\/asset_\w+\.png$/u);
  });

  it("refuses files it cannot type", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "notes.xyz"), "x");
    const res = await cli(["upload", "notes.xyz"], { cwd });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Cannot tell the media type");
  });
});

describe("auth", () => {
  it("checks the key in use", async () => {
    const ok = await cli(["auth", "status", "--json"]);
    expect(ok.code).toBe(0);
    expect(ok.json()).toMatchObject({ valid: true, key_source: "env", key: "sume_live_test0000…aaaa" });
    expect(ok.stdout).not.toContain(TEST_KEY);

    const bad = await cli(["auth", "status"], { key: "sume_live_wrong_wrong_wrong_wrong_wrong" });
    expect(bad.code).toBe(3);
    expect(bad.stdout).toContain("does not accept this key");
  });
});
