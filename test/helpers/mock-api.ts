import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small stand-in for the Sume Open API: the open catalog and estimate,
 * both routers, jobs, and direct upload, with the same envelopes and status
 * codes as the real API. Tests steer it through the public fields.
 */
export const TEST_KEY = "sume_live_test0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

export interface MockJob {
  id: string;
  type: string;
  model: string;
  status: "queued" | "processing" | "completed" | "failed" | "canceled";
  idempotency_key: string | null;
  input: Record<string, unknown>;
  created_at: string;
  /** Status reads left before the job moves on. */
  reads: number;
  outcome: "completed" | "failed";
  artifacts: number;
  poster: boolean;
  error: Record<string, unknown> | null;
}

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

const MODELS = [
  {
    id: "gpt-image-2",
    slug: "openai/gpt-image-2",
    name: "ChatGPT Image 2",
    kind: "image",
    company: { slug: "openai", name: "OpenAI" },
    description: "Generates and edits images",
    modes: ["text-to-image", "image-edit"],
    pricing: {
      currency: "USD",
      unit: "image",
      from_usd: "0.0077",
      from_usd_micros: 7700,
      qualifier: "from",
      options: [
        { label: "low", usd: "0.0077", usd_micros: 7700, quality: "low" },
        { label: "high", usd: "0.2639", usd_micros: 263900, quality: "high" },
      ],
    },
    capabilities: { text_to_image: true, image_edit: true, qualities: ["low", "high"], max_images: 4 },
    constraints: [],
  },
  {
    id: "seedance-2-mini",
    slug: "bytedance/seedance-2-mini",
    name: "Seedance 2.0 Mini",
    kind: "video",
    company: { slug: "bytedance", name: "ByteDance" },
    modes: ["text-to-video", "image-to-video"],
    pricing: { currency: "USD", unit: "second", from_usd: "0.0879", from_usd_micros: 87900, qualifier: "from" },
    capabilities: {
      text_to_video: true,
      image_to_video: true,
      resolutions: ["480p", "720p"],
      duration_seconds: { min: 4, max: 15 },
    },
    constraints: [],
  },
  {
    id: "veed-lipsync",
    slug: "veed/veed-lipsync",
    name: "VEED Lipsync",
    kind: "lipsync",
    company: { slug: "veed", name: "VEED" },
    modes: ["video-to-lipsync"],
    pricing: { currency: "USD", unit: "second", from_usd: "0.0084", from_usd_micros: 8400, qualifier: "from" },
    capabilities: { video_to_video: true, lipsync: true, duration_seconds: { min: 2, max: 60 } },
    constraints: [],
  },
];

export class MockApi {
  readonly requests: Recorded[] = [];
  readonly jobs = new Map<string, MockJob>();
  readonly uploads = new Map<string, { size: number; received: number; contentType: string }>();
  /** Answer the next N submits with this status (for retry tests). */
  failNextSubmits: { count: number; status: number; code: string } = { count: 0, status: 503, code: "database_busy" };
  /** Every new job ends like this. */
  nextOutcome: "completed" | "failed" = "completed";
  nextArtifacts = 1;
  /** Add a `stage: "poster"` frame to every new job's result. */
  nextPoster = false;
  /** Answer the next submits like a provider refusal: 502 with the job already failed. */
  refuseAtSubmit = false;
  readsUntilDone = 2;
  balanceUsd = 10;
  url = "";
  #server: Server | undefined;

  async start(): Promise<this> {
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "internal_error", message: String(error) } }));
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  calls(method: string, prefix: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const isJson = (req.headers["content-type"] ?? "").includes("json");
    const body = isJson && raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
    this.requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers, body });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-sume-request-id": `req_${randomUUID().replaceAll("-", "")}`,
        ...headers,
      });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, code: string, message = code, extra: Record<string, unknown> = {}) =>
      send(status, { error: { code, message, request_id: "req_test", retryable: status >= 500, ...extra } });
    const authed = () => req.headers.authorization === `Bearer ${TEST_KEY}`;
    const path = url.pathname;

    // Files the API "serves" from its CDN.
    if (req.method === "GET" && path.startsWith("/media/")) {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
      res.end(PNG);
      return;
    }
    if (req.method === "PUT" && path.startsWith("/storage/")) {
      const id = path.split("/")[2] as string;
      const upload = this.uploads.get(id);
      if (!upload || req.headers.authorization) return error(403, "forbidden");
      upload.received = raw.length;
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/health") {
      return send(
        200,
        { service: "mock", status: "ok", build: { commit_sha: "0123456789abcdef" } },
        { "x-sume-api-surface": "public" },
      );
    }
    if (req.method === "GET" && path === "/v1/open/catalog")
      return send(200, { data: { currency: "USD", models: MODELS } });
    if (req.method === "GET" && path.startsWith("/v1/open/catalog/")) {
      const model = MODELS.find((m) => m.id === decodeURIComponent(path.split("/").pop() ?? ""));
      return model ? send(200, { data: model }) : error(404, "model_not_found", "No such model.");
    }
    if (req.method === "POST" && path === "/v1/open/estimate") {
      const model = MODELS.find((m) => m.id === body?.model);
      if (!model) return error(404, "model_not_found");
      // Like the real estimate, a duration past the model's limit is priced at the limit.
      const duration = Math.min(Number(body.input?.duration ?? 0), 15);
      const usd = model.kind === "image" ? 0.0077 : 0.0879 * Math.max(duration, 1);
      return send(200, {
        data: {
          model: model.id,
          currency: "USD",
          usd: usd.toFixed(4),
          usd_micros: Math.round(usd * 1e6),
          route: "test",
          billing: { unit: "usd_micros", quantity: 1, duration_seconds: duration || null, resolution: null },
        },
      });
    }

    if (!authed()) return error(401, "unauthorized", "Missing or invalid API key.");

    if (req.method === "POST" && /^\/v1\/(image|video)-router\/generate$/u.test(path)) {
      if (this.failNextSubmits.count > 0) {
        this.failNextSubmits.count--;
        return error(this.failNextSubmits.status, this.failNextSubmits.code, "Try again.", {
          retry_after_seconds: null,
        });
      }
      if (this.balanceUsd <= 0) {
        return error(402, "insufficient_funds", "Balance too low.", {
          details: { required_usd: "0.0077", available_usd: "0.00" },
        });
      }
      if (!body?.model)
        return error(400, "invalid_request", "Invalid request body.", {
          details: { errors: [{ path: "model", message: "must have required property 'model'" }] },
        });
      const key = (req.headers["idempotency-key"] as string | undefined) ?? null;
      if (this.refuseAtSubmit) {
        const job = this.#createJob("image_generation", body, key);
        job.status = "failed";
        job.error = {
          code: "provider_submission_failed",
          message: 'Application "imagen4" not found',
          retryable: false,
        };
        return error(502, "provider_submission_failed", 'Application "imagen4" not found', {
          retryable: false,
          details: { request_id: job.id, job: this.#jobView(job) },
        });
      }
      const existing = key ? [...this.jobs.values()].find((j) => j.idempotency_key === key) : undefined;
      const job =
        existing ?? this.#createJob(path.includes("image") ? "image_generation" : "video_generation", body, key);
      return send(existing ? 200 : 202, {
        data: {
          ...this.#actions(job),
          request_id: job.id,
          job: this.#jobView(job),
          idempotency_hit: Boolean(existing),
        },
      });
    }

    const jobMatch = /^\/v1\/jobs\/([^/]+)(?:\/(status|result|cancel|events))?$/u.exec(path);
    if (req.method === "GET" && path === "/v1/jobs") {
      const jobs = [...this.jobs.values()].reverse().map((j) => this.#jobView(j));
      return send(200, { data: { jobs: jobs.slice(0, Number(url.searchParams.get("limit") ?? 20)) } });
    }
    if (jobMatch) {
      const job = this.jobs.get(decodeURIComponent(jobMatch[1] as string));
      if (!job) return error(404, "not_found", "API job was not found.");
      const action = jobMatch[2];
      if (req.method === "GET" && !action) return send(200, { data: { job: this.#jobView(job) } });
      if (req.method === "GET" && action === "status") {
        this.#advance(job);
        const upper = {
          queued: "IN_QUEUE",
          processing: "IN_PROGRESS",
          completed: "COMPLETED",
          failed: "FAILED",
          canceled: "CANCELED",
        }[job.status];
        return send(200, {
          data: {
            ...this.#actions(job),
            request_id: job.id,
            job_id: job.id,
            status: upper,
            sume_status: job.status,
            queue_position: null,
            job: this.#jobView(job),
          },
        });
      }
      if (req.method === "GET" && action === "result") {
        if (job.status !== "completed")
          return error(409, "job_not_completed", "Not done.", { details: { status: job.status } });
        return send(200, {
          data: {
            request_id: job.id,
            job_id: job.id,
            status: "COMPLETED",
            result: this.#result(job),
            job: this.#jobView(job),
          },
        });
      }
      if (req.method === "POST" && action === "cancel") {
        if (job.status !== "queued")
          return error(409, "job_not_cancelable", "API job can only be canceled before generation starts.");
        job.status = "canceled";
        return send(200, {
          data: {
            request_id: job.id,
            job_id: job.id,
            status: "CANCELED",
            canceled: true,
            idempotency_hit: false,
            job: this.#jobView(job),
          },
        });
      }
      if (req.method === "GET" && action === "events") {
        const events = [
          { id: "evt_1", type: "job.created", status: "info", message: "Job created.", created_at: job.created_at },
          {
            id: "evt_2",
            type: job.status === "failed" ? "job.failed" : "job.completed",
            status: job.status === "failed" ? "failed" : "succeeded",
            created_at: new Date(Date.parse(job.created_at) + 4200).toISOString(),
            // Like the real API, the failed event carries no reason; the job does.
            data: { terminal_event_status: job.status },
          },
        ];
        return send(200, { data: { request_id: job.id, job_id: job.id, events } });
      }
    }

    if (req.method === "POST" && path === "/v1/assets/upload-url") {
      const id = `asset_${randomUUID().slice(0, 8)}`;
      this.uploads.set(id, { size: body.size_bytes, received: 0, contentType: body.content_type });
      return send(201, {
        data: {
          asset: { id, media_type: "image", status: "pending_upload", url: null },
          upload: {
            asset_id: id,
            url: `${this.url}/storage/${id}`,
            method: "PUT",
            headers: { "content-type": body.content_type },
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        },
      });
    }
    const complete = /^\/v1\/assets\/([^/]+)\/complete$/u.exec(path);
    if (req.method === "POST" && complete) {
      const id = complete[1] as string;
      const upload = this.uploads.get(id);
      if (!upload) return error(404, "not_found");
      if (upload.received !== upload.size)
        return error(409, "upload_incomplete", "The stored object's size does not match.");
      return send(200, {
        data: { asset: { id, media_type: "image", status: "ready", url: `${this.url}/media/${id}.png` } },
      });
    }

    return error(404, "not_found", `No route ${req.method} ${path}`);
  }

  #createJob(type: string, body: Record<string, unknown>, key: string | null): MockJob {
    const { model, ...input } = body;
    const job: MockJob = {
      id: `job_${randomUUID()}`,
      type,
      model: String(model),
      status: "queued",
      idempotency_key: key,
      input,
      created_at: new Date().toISOString(),
      reads: this.readsUntilDone,
      outcome: this.nextOutcome,
      artifacts: this.nextArtifacts,
      poster: this.nextPoster,
      error: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  #advance(job: MockJob): void {
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return;
    job.reads--;
    if (job.reads > 0) {
      job.status = "processing";
      return;
    }
    job.status = job.outcome;
    if (job.outcome === "failed") {
      job.error = {
        code: "generation_failed",
        message: "The model refused the prompt.",
        category: "generation_rejected",
        retryable: false,
      };
    }
  }

  #result(job: MockJob) {
    const artifacts: Record<string, unknown>[] = Array.from({ length: job.artifacts }, (_, i) => ({
      id: `artf_${i}`,
      type: "image",
      url: `${this.url}/media/${job.id}-${i}.png`,
      content_type: "image/png",
      width: 1,
      height: 1,
    }));
    if (job.poster) {
      artifacts.push({
        id: "artf_poster",
        type: "image",
        stage: "poster",
        url: `${this.url}/media/${job.id}-poster.jpg`,
        content_type: "image/jpeg",
      });
    }
    return { artifacts };
  }

  #jobView(job: MockJob) {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      model: job.model,
      idempotency_key: job.idempotency_key,
      created_at: job.created_at,
      started_at: job.created_at,
      completed_at: job.status === "completed" || job.status === "failed" ? new Date().toISOString() : null,
      input: job.input,
      result: job.status === "completed" ? this.#result(job) : null,
      error: job.error,
    };
  }

  #actions(job: MockJob) {
    const terminal = ["completed", "failed", "canceled"].includes(job.status);
    return {
      status_url: `${this.url}/v1/jobs/${job.id}/status`,
      result_url: `${this.url}/v1/jobs/${job.id}/result`,
      events_url: `${this.url}/v1/jobs/${job.id}/events`,
      cancel_url: job.status === "queued" ? `${this.url}/v1/jobs/${job.id}/cancel` : null,
      cancelable: job.status === "queued",
      next_action: job.status === "completed" ? "fetch_result" : terminal ? "inspect_events" : "poll_status",
      // Tests poll fast; the CLI clamps to at least one second, so tests use 0 through a fake sleep.
      next_poll_after_seconds: terminal ? null : 1,
      recommended_poll_interval_seconds: terminal ? null : 1,
      retry_after_seconds: null,
      result_ready: job.status === "completed",
      terminal,
    };
  }
}
