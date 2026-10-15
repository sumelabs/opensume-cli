import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeStatus, SumeClient } from "../src/api/client.ts";
import type { StatusResponse } from "../src/api/types.ts";
import { downloadTo } from "../src/lib/download.ts";
import { waitForJob } from "../src/lib/wait.ts";
import { MockApi, PNG, TEST_KEY } from "./helpers/mock-api.ts";
import { runCli, tempDir } from "./helpers/run-cli.ts";

let api: MockApi;
const cli = (args: string[], options: Parameters<typeof runCli>[1] = {}) =>
  runCli(args, { baseUrl: api.url, key: TEST_KEY, ...options });
// Permission tests mean nothing to root, and Windows has no read-only folders in this sense.
const posixUser = process.platform !== "win32" && process.getuid?.() !== 0;

beforeAll(async () => {
  api = await new MockApi().start();
});
afterAll(async () => {
  await api.stop();
});
beforeEach(() => {
  api.requests.length = 0;
  api.faults = [];
  api.nextOutcome = "completed";
  api.nextArtifacts = 1;
  api.readsUntilDone = 2;
});

describe("network failures", () => {
  it("retries a read whose connection drops after the headers, and counts the tries when it gives up", async () => {
    api.faults = [{ method: "GET", path: "/v1/open/catalog", times: 1, kind: "drop-body" }];
    expect((await cli(["models", "--json"], { key: null })).code).toBe(0);

    api.faults = [{ method: "GET", path: "/v1/open/catalog", times: 10, kind: "drop-body" }];
    const res = await cli(["models", "--json"], { key: null });
    expect(res.code).toBe(1);
    const { error } = res.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("tried 4 times");
  });

  it("names a proxy's error page by its status, not its HTML, and points at the status page", async () => {
    api.faults = [{ method: "GET", path: "/v1/open/catalog", times: 10, kind: "html", status: 502 }];
    const res = await cli(["models", "--json"], { key: null });
    expect(res.code).toBe(1);
    const { error } = res.json<{ error: { message: string; hint: string } }>();
    expect(error.message).toMatch(/answered 502 Bad Gateway \(tried 4 times\)\.$/u);
    expect(error.message).not.toContain("<");
    expect(error.hint).toContain("https://status.sume.com");
  });

  it("rides out a status outage mid-wait, says so once, and says when it is back", async () => {
    api.readsUntilDone = 3;
    // Each failed read is itself retried 3 times: 12 failed answers make 3 failed reads.
    api.faults = [{ method: "GET", path: /\/status$/u, times: 12, kind: "status", status: 503 }];
    const res = await cli(["run", "gpt-image-2", "a cup", "--no-download"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("Lost contact with the API");
    expect(res.stderr).toContain("Back in contact with the API.");
  });

  it("says the job's state is unknown when the wait ends during an outage", async () => {
    const client = new SumeClient({ baseUrl: api.url, apiKey: TEST_KEY, userAgent: "test", sleep: async () => {} });
    const job = (await client.generate("image", { model: "gpt-image-2", prompt: "x" }, "outage")).data.job;
    api.faults = [{ method: "GET", path: /\/status$/u, times: 1000, kind: "drop" }];
    let clock = 0;
    await expect(
      waitForJob(client, job.id, {
        timeoutMs: 60_000,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      }),
    ).rejects.toThrow(/status reads? failed, so job .* may still be running/u);
  });
});

describe("downloads", () => {
  it("saves every file it can, names the missing one, and a second wait fetches only that", async () => {
    const cwd = tempDir();
    api.nextArtifacts = 3;
    api.faults = [{ method: "GET", path: /-1\.png$/u, times: 3, kind: "drop" }];
    const first = await cli(["run", "gpt-image-2", "a cup", "--json"], { cwd });
    expect(first.code).toBe(1);
    const doc = first.json<{
      error: { code: string; message: string; hint: string; job_id: string };
      artifacts: { path: string | null; error?: string }[];
    }>();
    expect(doc.error.message).toMatch(/^Saved 2 of 3 files\. Could not download .*-1\.png/u);
    expect(doc.error.hint).toBe(`Get the missing file with: opensume jobs wait ${doc.error.job_id}`);
    expect(doc.artifacts.map((a) => a.path === null)).toEqual([false, true, false]);
    expect(readdirSync(cwd)).toHaveLength(2);

    const again = await cli(["jobs", "wait", doc.error.job_id, "--json"], { cwd });
    expect(again.code).toBe(0);
    const files = again.json<{ artifacts: { path: string; already_saved?: boolean }[] }>().artifacts;
    expect(files.map((f) => f.already_saved === true)).toEqual([true, false, true]);
    // Three files, no "-2" copies of the two saved before.
    expect(readdirSync(cwd).sort()).toEqual(files.map((f) => f.path.split(/[\\/]/u).pop()).sort());
  });

  it("refuses an empty body or a web page in place of an image", async () => {
    api.faults = [{ method: "GET", path: "/media/", times: 3, kind: "empty" }];
    const empty = await cli(["run", "gpt-image-2", "a cup"], { cwd: tempDir() });
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("the download was empty, tried 3 times");

    api.faults = [{ method: "GET", path: "/media/", times: 3, kind: "page" }];
    const page = await cli(["run", "gpt-image-2", "a cup"], { cwd: tempDir() });
    expect(page.stderr).toContain("got a web page instead of the file");
  });

  it.runIf(posixUser)("does not retry a write the disk refuses", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "ro"));
    chmodSync(join(dir, "ro"), 0o500);
    let fetches = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetches++;
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    };
    await expect(
      downloadTo("https://media.sume.com/a.png", join(dir, "ro", "a.png"), {
        userAgent: "test",
        fetch,
        sleep: async () => {},
        expect: { kind: "image" },
      }),
    ).rejects.toMatchObject({ code: "write_failed", message: expect.stringContaining("permission denied") });
    expect(fetches).toBe(1);
    chmodSync(join(dir, "ro"), 0o700);
  });

  it("checks a declared size and checksum before the file gets its name", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(PNG, { headers: { "content-type": "image/png" } });
    const dir = tempDir();
    const options = { userAgent: "test", fetch, sleep: async () => {}, attempts: 1 };
    await expect(
      downloadTo("https://media.sume.com/a.png", join(dir, "a.png"), {
        ...options,
        expect: { kind: "image", bytes: PNG.length + 1 },
      }),
    ).rejects.toThrow(/the job says/u);
    await expect(
      downloadTo("https://media.sume.com/a.png", join(dir, "a.png"), {
        ...options,
        expect: { kind: "image", sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow(/does not match its checksum/u);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("before anything is paid for", () => {
  it.runIf(posixUser)("refuses a save folder it cannot write, and submits nothing", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "ro"));
    chmodSync(join(cwd, "ro"), 0o500);
    writeFileSync(join(cwd, "afile"), "x");
    const ro = await cli(["run", "gpt-image-2", "a cup", "-o", "ro/cup.png"], { cwd });
    expect(ro.code).toBe(2);
    expect(ro.stderr).toContain("Cannot save files to ro: ro is not writable.");
    expect(ro.stderr).toContain("Nothing was submitted.");
    const file = await cli(["run", "gpt-image-2", "a cup", "-o", "afile/cup.png"], { cwd });
    expect(file.code).toBe(2);
    expect(file.stderr).toContain("afile is a file, not a folder");
    expect(api.calls("POST", "/v1/image-router")).toHaveLength(0);
    chmodSync(join(cwd, "ro"), 0o700);
  });

  it("refuses empty values: an unset shell variable must not change what is paid for", async () => {
    const image = await cli(["run", "gpt-image-2", "a cup", "--image", ""]);
    expect(image.code).toBe(2);
    expect(image.stderr).toContain("--image is empty.");
    expect(image.stderr).toContain("that variable is not set");
    expect((await cli(["run", "gpt-image-2", ""])).stderr).toContain("<prompt> is empty.");
    expect((await cli(["run", "gpt-image-2", "a cup", "-o", ""])).code).toBe(2);
    expect(api.calls("POST", "/v1/image-router")).toHaveLength(0);
  });

  it("checks numbers, keys, webhooks, URLs and --input against the API's own rules", async () => {
    const cases: [string[], RegExp][] = [
      [["jobs", "list", "--limit", "0"], /--limit must be from 1 to 100 \(got 0\)/u],
      [["jobs", "list", "--limit", "2.5"], /--limit must be a whole number/u],
      [["run", "gpt-image-2", "a", "--max-usd", "-1"], /--max-usd must be 0 or more/u],
      [["run", "gpt-image-2", "a", "-n", "0"], /--num-images must be 1 or more/u],
      [["run", "gpt-image-2", "a", "--idempotency-key", "a\nb"], /printable ASCII/u],
      [["run", "gpt-image-2", "a", "--webhook", "http://example.com/hook"], /public https URL/u],
      [["run", "gpt-image-2", "a", "--image", "https://"], /is not a valid URL/u],
      [["run", "gpt-image-2", "a", "--image", "missing.png"], /No such file/u],
    ];
    for (const [args, message] of cases) {
      const res = await cli(args, { cwd: tempDir() });
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr, args.join(" ")).toMatch(message);
    }
    const cwd = tempDir();
    writeFileSync(join(cwd, "bad.json"), "{not json");
    const input = await cli(["run", "gpt-image-2", "a", "--input", "bad.json"], { cwd });
    expect(input.stderr).toMatch(/--input bad\.json is not valid JSON: .+/u);
    expect((await cli(["run", "gpt-image-2", "a", "--input", "nope.json"], { cwd })).stderr).toContain(
      "Cannot read --input nope.json: no such file.",
    );
    expect(api.calls("POST", "/v1/image-router")).toHaveLength(0);
  });

  it("fails on a missing key before any network call", async () => {
    const res = await cli(["run", "gpt-image-2", "a cup"], { key: null, cwd: tempDir() });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("No API key.");
    expect(api.requests).toHaveLength(0);
  });
});

describe("uploads", () => {
  it("retries a storage PUT that fails, then completes", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "a.png"), PNG);
    api.faults = [{ method: "PUT", path: "/storage/", times: 2, kind: "status", status: 503 }];
    const res = await cli(["upload", "a.png", "--json"], { cwd });
    expect(res.code).toBe(0);
    expect(api.calls("PUT", "/storage/")).toHaveLength(3);
  });

  it("checks every file before the first upload, and reports which uploads failed", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "a.png"), PNG);
    const typo = await cli(["upload", "a.png", "nope.png"], { cwd });
    expect(typo.code).toBe(2);
    expect(api.calls("POST", "/v1/assets/upload-url")).toHaveLength(0);

    const res = await cli(["upload", "a.png", "https://127.0.0.1:1/x.png", "--json"], { cwd });
    expect(res.code).toBe(1);
    const doc = res.json<{
      error: { message: string; hint: string };
      uploaded: unknown[];
      failed: { path: string }[];
    }>();
    expect(doc.uploaded).toHaveLength(1);
    expect(doc.failed.map((f) => f.path)).toEqual(["https://127.0.0.1:1/x.png"]);
    expect(doc.error.message).toBe("Uploaded 1 of 2; https://127.0.0.1:1/x.png failed.");
  });
});

describe("files the CLI reads and writes", () => {
  it("explains a config file it cannot read instead of crashing", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "config.json"));
    const res = await cli(["jobs", "list"], { env: { OPENSUME_CONFIG_DIR: dir } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`Cannot read ${join(dir, "config.json")}`);
    expect(res.stderr).not.toContain("Unexpected error");
  });

  it("explains an agent file it cannot write instead of crashing", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "AGENTS.md"));
    const res = await cli(["agent", "--write", "AGENTS.md"], { cwd });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("it is a folder");
    expect(res.stderr).not.toContain("Unexpected error");
  });
});

describe("status reads", () => {
  it("derives the state from the queue-style status when sume_status is missing", () => {
    const base = { job_id: "job_x", request_id: "r", queue_position: null } as unknown as StatusResponse;
    expect(normalizeStatus({ ...base, status: "COMPLETED" } as StatusResponse)).toMatchObject({
      sume_status: "completed",
      terminal: true,
    });
    expect(normalizeStatus({ ...base, status: "IN_PROGRESS" } as StatusResponse)).toMatchObject({
      sume_status: "processing",
      terminal: false,
    });
  });
});

describe.runIf(process.platform !== "win32")("signals", () => {
  it("on SIGTERM, prints the job in --json and exits 130, so an agent can pick it up", async () => {
    api.readsUntilDone = 10_000;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "src/bin.ts", "run", "gpt-image-2", "a cup", "--json"],
      {
        cwd: join(import.meta.dirname, ".."),
        env: {
          ...process.env,
          SUME_API_BASE_URL: api.url,
          SUME_API_KEY: TEST_KEY,
          OPENSUME_CONFIG_DIR: tempDir(),
          NO_COLOR: "1",
        },
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // Wait for the submit, then for the first status read.
    for (let i = 0; i < 200 && api.calls("GET", "/v1/jobs/").length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(130);
    const doc = JSON.parse(stdout) as { error: { code: string; job_id: string; hint: string } };
    expect(doc.error.code).toBe("interrupted");
    expect(doc.error.job_id).toMatch(/^job_/u);
    expect(doc.error.hint).toBe(`Pick it up with: opensume jobs wait ${doc.error.job_id}`);
  });
});
