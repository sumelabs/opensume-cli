import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SumeClient } from "../src/api/client.ts";
import { maxDelaySeconds, parseDuration, waitForJob } from "../src/lib/wait.ts";
import { MockApi, TEST_KEY } from "./helpers/mock-api.ts";

let api: MockApi;
beforeAll(async () => {
  api = await new MockApi().start();
});
afterAll(async () => {
  await api.stop();
});

describe("waitForJob", () => {
  it("caps the API's poll hint by the job's age", async () => {
    expect(maxDelaySeconds(0)).toBe(5);
    expect(maxDelaySeconds(59_000)).toBe(5);
    expect(maxDelaySeconds(60_000)).toBe(10);
    expect(maxDelaySeconds(3_600_000)).toBe(15);
  });

  it("polls until terminal, sleeping what the API asks for", async () => {
    const client = new SumeClient({ baseUrl: api.url, apiKey: TEST_KEY, userAgent: "test" });
    api.readsUntilDone = 3;
    const submit = await client.generate("image", { model: "gpt-image-2", prompt: "x" }, "wait-test");
    const sleeps: number[] = [];
    const delays: [number, number | null][] = [];
    const status = await waitForJob(client, submit.data.job.id, {
      timeoutMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onDelay: (delay, hint) => delays.push([delay, hint]),
    });
    expect(status.sume_status).toBe("completed");
    expect(sleeps).toEqual([1000, 1000]);
    expect(delays).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });
});

describe("parseDuration", () => {
  it("reads plain seconds and units", () => {
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("250ms")).toBe(250);
  });

  it("refuses anything else", () => {
    expect(() => parseDuration("soon")).toThrow(/Not a duration/u);
    expect(() => parseDuration("5x")).toThrow(/Not a duration/u);
    expect(() => parseDuration("0s")).toThrow(/Not a duration/u);
  });
});
