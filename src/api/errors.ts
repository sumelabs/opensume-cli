import { KEYS_URL, otherHostHint } from "../lib/config.ts";
import { CliError, ExitCode } from "../lib/errors.ts";
import type { ApiErrorBody } from "./types.ts";

const BILLING_URL = "https://open.sume.com/billing";
const STATUS_URL = "https://status.sume.com";

/** A non-2xx answer from the API, with its `error` envelope. */
export class ApiError extends CliError {
  readonly status: number;
  readonly apiCode: string;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly details: unknown;
  readonly body: ApiErrorBody;

  /** `baseUrl` is the host that answered, for hints that name it. */
  constructor(status: number, body: ApiErrorBody, requestId?: string, baseUrl?: string) {
    super(body.message || `The API answered ${status}.`, {
      exitCode: exitCodeFor(status, body.code),
      code: body.code,
      hint: hintFor(status, body, baseUrl),
    });
    this.name = "ApiError";
    this.status = status;
    this.apiCode = body.code;
    this.requestId = body.request_id ?? requestId;
    this.retryable = body.retryable ?? (status === 429 || status >= 500);
    this.retryAfterSeconds = body.retry_after_seconds ?? undefined;
    this.details = body.details;
    this.body = body;
  }

  /**
   * The job a refused submit created anyway: the API answers some provider
   * refusals with the job already `failed` in `details.job`.
   */
  failedJob():
    | { id: string; model: string | null; status: string; error?: { message?: string; retryable?: boolean } }
    | undefined {
    const job = (this.details as { job?: unknown } | undefined)?.job as
      | { id?: unknown; model?: unknown; status?: unknown; error?: unknown }
      | undefined;
    if (!job || typeof job.id !== "string" || (job.status !== "failed" && job.status !== "canceled")) return undefined;
    return {
      id: job.id,
      model: typeof job.model === "string" ? job.model : null,
      status: job.status,
      ...(job.error && typeof job.error === "object"
        ? { error: job.error as { message?: string; retryable?: boolean } }
        : {}),
    };
  }

  /** Field-level problems from `details.errors[]`, one line each. */
  fieldErrors(): string[] {
    const errors = (this.details as { errors?: unknown } | undefined)?.errors;
    if (!Array.isArray(errors)) return [];
    return errors.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const { path, message } = entry as { path?: unknown; message?: unknown };
      if (typeof message !== "string") return [];
      return [typeof path === "string" && path ? `${path}: ${message}` : message];
    });
  }
}

export function exitCodeFor(status: number, code: string | undefined): ExitCode {
  if (code === "concurrency_limit_reached" || code === "queue_full") return ExitCode.RateLimited;
  if (status === 401 || status === 403) return ExitCode.Auth;
  if (status === 402) return ExitCode.Funds;
  if (status === 429) return ExitCode.RateLimited;
  if (status >= 400 && status < 500) return ExitCode.Rejected;
  return ExitCode.Error;
}

function hintFor(status: number, body: ApiErrorBody, baseUrl: string | undefined): string | undefined {
  const details = (body.details ?? {}) as Record<string, unknown>;
  switch (body.code) {
    case "unauthorized":
      return baseUrl
        ? `${otherHostHint(baseUrl)} Check the key with \`opensume auth status\`.`
        : `Check the key with \`opensume auth status\`. Create one at ${KEYS_URL}.`;
    case "open_key_route_not_allowed":
      return "open.sume.com keys call images, video, jobs and prices only.";
    case "session_not_accepted":
    case "api_key_not_accepted": {
      const base = details.public_api_base_url;
      return typeof base === "string"
        ? `Send keys to the public API: --base-url ${base}`
        : "Send keys to the public API host.";
    }
    case "insufficient_funds": {
      const need = details.required_usd;
      const have = details.available_usd;
      const amounts = typeof need === "string" && typeof have === "string" ? ` (needs $${need}, balance $${have})` : "";
      return `Top up at ${BILLING_URL}${amounts}.`;
    }
    case "concurrency_limit_reached":
      return "Your workspace has as many jobs in flight as it may. Wait for one to finish, then submit again.";
    case "job_not_completed":
      return "The job has not finished. Wait for it with `opensume jobs wait <id>`.";
    case "job_not_cancelable":
    case "job_generation_already_started":
      return "Generation has started; the job will finish or fail on its own. Failed jobs are refunded.";
    case "idempotency_conflict":
      return "That idempotency key belongs to a different request. Use a new key.";
    case "model_not_found":
      return "List the models with `opensume models`.";
    default:
      break;
  }
  if (status === 429) {
    const after = body.retry_after_seconds;
    return typeof after === "number" && after > 0
      ? `Rate limited: retry in ${Math.ceil(after)}s.`
      : "Slow down and retry after a moment.";
  }
  if (status >= 500) {
    return body.retryable === false
      ? "This is on Sume's side, and the same request will fail again. Quote the request id to support."
      : `This is on Sume's side. Retry in a minute (status: ${STATUS_URL}), and quote the request id if it persists.`;
  }
  return undefined;
}
