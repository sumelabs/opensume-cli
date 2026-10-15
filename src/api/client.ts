import { CliError, ExitCode } from "../lib/errors.ts";
import { ApiError } from "./errors.ts";
import type {
  ApiErrorBody,
  Asset,
  CancelResponse,
  Catalog,
  CatalogModel,
  Estimate,
  Job,
  JobEvents,
  JobList,
  ResultResponse,
  StatusResponse,
  SubmitResponse,
  UploadTarget,
} from "./types.ts";

export type Router = "image" | "video";

export interface RequestInfo {
  method: string;
  url: string;
  attempt: number;
}

export interface ResponseInfo extends RequestInfo {
  status: number;
  requestId: string | undefined;
  ms: number;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  userAgent: string;
  /** Retries after the first attempt, for retry-safe requests. */
  maxRetries?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRequest?: (info: RequestInfo) => void;
  onResponse?: (info: ResponseInfo) => void;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  /** Per-attempt timeout for this request, overriding the client's. */
  timeoutMs?: number;
  body?: unknown;
  /** `none` never sends the key, `optional` sends it when there is one. */
  auth?: "required" | "optional" | "none";
  idempotencyKey?: string | undefined;
  /** Defaults to true for GET, and for POST only with an idempotency key. */
  retry?: boolean;
  signal?: AbortSignal | undefined;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  requestId: string | undefined;
  headers: Headers;
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 30_000;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A thin client for the Sume Open API. It owns the parts every call shares:
 * the key, the `data`/`error` envelopes, request ids, and retrying what is
 * safe to retry (reads, and submits that carry an `Idempotency-Key`).
 */
export class SumeClient {
  readonly baseUrl: string;
  readonly hasKey: boolean;
  readonly #apiKey: string | undefined;
  readonly #userAgent: string;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #onRequest: ((info: RequestInfo) => void) | undefined;
  readonly #onResponse: ((info: ResponseInfo) => void) | undefined;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#apiKey = checkKey(options.apiKey);
    this.hasKey = this.#apiKey !== undefined;
    this.#userAgent = options.userAgent;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? sleep;
    this.#onRequest = options.onRequest;
    this.#onResponse = options.onResponse;
  }

  // Models and prices (public, no key needed).

  async listModels(signal?: AbortSignal): Promise<CatalogModel[]> {
    const res = await this.request<Catalog>("GET", "/v1/open/catalog", { auth: "optional", signal });
    return res.data.models;
  }

  async getModel(id: string, signal?: AbortSignal): Promise<CatalogModel> {
    const res = await this.request<CatalogModel>("GET", `/v1/open/catalog/${encodeURIComponent(id)}`, {
      auth: "optional",
      signal,
    });
    return res.data;
  }

  async estimate(model: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Estimate> {
    const res = await this.request<Estimate>("POST", "/v1/open/estimate", {
      auth: "optional",
      body: { model, input },
      retry: true,
      signal,
    });
    return res.data;
  }

  // Generation.

  async generate(
    router: Router,
    body: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResponse<SubmitResponse>> {
    return this.request<SubmitResponse>("POST", `/v1/${router}-router/generate`, {
      body,
      idempotencyKey,
      signal,
    });
  }

  // Jobs.

  async getStatus(id: string, signal?: AbortSignal): Promise<ApiResponse<StatusResponse>> {
    // Short: a status read that hangs should be retried, not waited out.
    return this.request<StatusResponse>("GET", `/v1/jobs/${encodeURIComponent(id)}/status`, {
      signal,
      timeoutMs: 20_000,
    });
  }

  async getJob(id: string, signal?: AbortSignal): Promise<Job> {
    return (await this.request<{ job: Job }>("GET", `/v1/jobs/${encodeURIComponent(id)}`, { signal })).data.job;
  }

  async getResult(id: string, signal?: AbortSignal): Promise<ResultResponse> {
    return (await this.request<ResultResponse>("GET", `/v1/jobs/${encodeURIComponent(id)}/result`, { signal })).data;
  }

  async listJobs(
    query: { limit?: number; status?: string; type?: string; starting_after?: string },
    signal?: AbortSignal,
  ): Promise<JobList> {
    return (await this.request<JobList>("GET", "/v1/jobs", { query, signal })).data;
  }

  async cancelJob(id: string, signal?: AbortSignal): Promise<CancelResponse> {
    // Canceling twice is harmless, so a retry is safe.
    return (
      await this.request<CancelResponse>("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`, {
        retry: true,
        signal,
      })
    ).data;
  }

  async listEvents(id: string, limit?: number, signal?: AbortSignal): Promise<JobEvents> {
    return (
      await this.request<JobEvents>("GET", `/v1/jobs/${encodeURIComponent(id)}/events`, {
        query: { limit },
        signal,
      })
    ).data;
  }

  // Direct upload.

  async createUpload(
    params: { content_type: string; size_bytes: number; filename?: string },
    signal?: AbortSignal,
  ): Promise<UploadTarget> {
    return (await this.request<UploadTarget>("POST", "/v1/assets/upload-url", { body: params, signal })).data;
  }

  async completeUpload(id: string, sizeBytes: number, signal?: AbortSignal): Promise<Asset> {
    const res = await this.request<{ asset: Asset }>("POST", `/v1/assets/${encodeURIComponent(id)}/complete`, {
      body: { size_bytes: sizeBytes },
      retry: true,
      signal,
    });
    return res.data.asset;
  }

  // Transport.

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T>(method: "GET" | "POST", path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const auth = options.auth ?? "required";
    if (auth === "required" && !this.#apiKey) {
      throw new CliError("No API key. Set SUME_API_KEY or run `opensume auth login`.", {
        exitCode: ExitCode.Auth,
        code: "missing_api_key",
        hint: "Create a key at https://open.sume.com/api-keys.",
      });
    }
    const url = this.url(path, options.query);
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.#userAgent,
    };
    if (auth !== "none" && this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const retry = options.retry ?? (method === "GET" || options.idempotencyKey !== undefined);
    const attempts = retry ? this.#maxRetries + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      this.#onRequest?.({ method, url, attempt });
      const started = performance.now();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          body: body ?? null,
          signal: withTimeout(options.signal, options.timeoutMs ?? this.#timeoutMs),
        });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (attempt < attempts) {
          await this.#sleep(backoffMs(attempt), options.signal);
          continue;
        }
        throw networkError(url, error);
      }
      const requestId = response.headers.get("x-sume-request-id") ?? undefined;
      this.#onResponse?.({
        method,
        url,
        attempt,
        status: response.status,
        requestId,
        ms: Math.round(performance.now() - started),
      });
      const text = await response.text();
      const json = parseJson(text);

      if (response.ok) {
        const envelope = json as { data?: T } | undefined;
        if (!envelope || typeof envelope !== "object" || !("data" in envelope)) {
          throw new CliError(`Unexpected response from ${method} ${path} (${response.status}).`, {
            code: "unexpected_response",
            hint: requestId ? `Request id: ${requestId}` : undefined,
          });
        }
        return { data: envelope.data as T, status: response.status, requestId, headers: response.headers };
      }

      const errorBody = toErrorBody(json, response.status, text);
      const apiError = new ApiError(response.status, errorBody, requestId, this.baseUrl);
      if (attempt < attempts && RETRY_STATUSES.has(response.status) && errorBody.code !== "concurrency_limit_reached") {
        const after = retryAfterMs(response.headers, errorBody);
        await this.#sleep(after ?? backoffMs(attempt), options.signal);
        continue;
      }
      throw apiError;
    }
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `https://api.dev.sume.com/v1/` → `https://api.dev.sume.com`. Plain http is
 * allowed for local test servers only: anywhere else it would send the key
 * across the network in the clear.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CliError(`Not a URL: ${raw}`, { exitCode: ExitCode.Usage, code: "invalid_base_url" });
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new CliError(`The API base URL must use https: ${raw}`, {
      exitCode: ExitCode.Usage,
      code: "invalid_base_url",
      hint: "Plain http is accepted only for localhost.",
    });
  }
  const path = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  return `${url.origin}${path}`;
}

/**
 * A key goes into an HTTP header, so anything but printable ASCII (a line
 * break from a sloppy paste, a space) is refused here, by name of the
 * problem only. Left to `fetch`, the header error would quote the key.
 */
function checkKey(raw: string | undefined): string | undefined {
  const key = raw?.trim();
  if (!key) return undefined;
  if (!/^[\x21-\x7e]+$/u.test(key)) {
    throw new CliError("The API key contains spaces, line breaks or other characters a key never has.", {
      exitCode: ExitCode.Auth,
      code: "invalid_api_key",
      hint: "Copy the key again from https://open.sume.com/api-keys.",
    });
  }
  return key;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toErrorBody(json: unknown, status: number, text: string): ApiErrorBody {
  const error = (json as { error?: unknown } | undefined)?.error;
  if (error && typeof error === "object" && typeof (error as ApiErrorBody).code === "string") {
    return error as ApiErrorBody;
  }
  const snippet = text.trim().slice(0, 200);
  return {
    code: `http_${status}`,
    message: snippet ? `The API answered ${status}: ${snippet}` : `The API answered ${status}.`,
  };
}

function retryAfterMs(headers: Headers, body: ApiErrorBody): number | undefined {
  const header = Number(headers.get("retry-after"));
  const seconds = Number.isFinite(header) && header > 0 ? header : (body.retry_after_seconds ?? undefined);
  if (seconds === undefined || !(seconds > 0)) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

/** 0.5 s, 1 s, 2 s, … with ±25% jitter, capped at 8 s. */
export function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function networkError(url: string, error: unknown): CliError {
  const host = new URL(url).host;
  const reason =
    error instanceof Error && error.name === "TimeoutError"
      ? "timed out"
      : error instanceof Error
        ? ((error.cause as { code?: string } | undefined)?.code ?? redact(error.message))
        : redact(String(error));
  return new CliError(`Could not reach ${host} (${reason}).`, {
    code: "network_error",
    hint: "Check your connection, or the base URL with `opensume auth status`.",
    cause: error,
  });
}

/** Errors from the HTTP stack can quote header values; never let a key through. */
export function redact(text: string): string {
  return text.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/sume_[A-Za-z0-9_-]{8,}/gu, "[redacted key]");
}
