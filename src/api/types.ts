/**
 * The parts of the Sume Open API this CLI reads. Field names follow the wire
 * format (snake_case) so a response can be printed with `--json` unchanged.
 * The full contract is the OpenAPI document the API serves at
 * `GET /v1/openapi.json`.
 */

export type ModelKind = "image" | "video" | "lipsync" | "captions";

/** Lower-case lifecycle state (`sume_status` on the status endpoint). */
export type JobState = "queued" | "processing" | "completed" | "failed" | "canceled";

export type NextAction = "poll_status" | "fetch_result" | "inspect_events";

export interface ApiErrorBody {
  code: string;
  message: string;
  request_id?: string;
  category?: string;
  stage?: string;
  retryable?: boolean;
  retry_after_seconds?: number | null;
  public_reason?: string;
  next_action?: string;
  details?: unknown;
}

export interface PriceOption {
  label: string;
  usd: string;
  usd_micros: number;
  route?: string;
  resolution?: string;
  quality?: string;
  [key: string]: unknown;
}

export interface CatalogModel {
  id: string;
  slug: string;
  name: string;
  kind: ModelKind;
  description?: string;
  modes?: string[];
  company: { slug: string; name: string };
  pricing: {
    currency: string;
    unit: string;
    from_usd: string;
    from_usd_micros: number;
    to_usd?: string;
    qualifier?: string;
    options?: PriceOption[];
  };
  capabilities?: Record<string, unknown>;
  constraints?: string[];
}

export interface Catalog {
  currency: string;
  models: CatalogModel[];
}

export interface Estimate {
  model: string;
  currency: string;
  usd: string;
  usd_micros: number;
  route?: string;
  billing?: {
    unit?: string;
    quantity?: number;
    duration_seconds?: number | null;
    resolution?: string | null;
  };
}

export interface Artifact {
  id: string;
  type: "image" | "video" | "audio" | "model" | "file";
  /** Set on intermediate files, like a video's `poster` frame. Final outputs have none. */
  stage?: string;
  url: string;
  content_type: string;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  checksum_sha256?: string | null;
}

export interface JobError {
  code?: string;
  message?: string;
  category?: string;
  stage?: string;
  retryable?: boolean;
  retry_after_seconds?: number | null;
  public_reason?: string;
  next_action?: string;
}

export interface Job {
  id: string;
  type: string;
  status: JobState;
  model: string | null;
  idempotency_key: string | null;
  communication_mode?: string;
  created_at: string;
  updated_at?: string;
  started_at: string | null;
  completed_at: string | null;
  canceled_at?: string | null;
  input?: Record<string, unknown>;
  result: { artifacts?: Artifact[]; [key: string]: unknown } | null;
  error: JobError | null;
}

/** Fields shared by the submit (`202`) and status responses. */
export interface JobActions {
  status_url: string;
  result_url: string;
  events_url: string;
  cancel_url: string | null;
  cancelable: boolean;
  next_action: NextAction;
  next_poll_after_seconds: number | null;
  recommended_poll_interval_seconds: number | null;
  retry_after_seconds: number | null;
  result_ready: boolean;
  terminal: boolean;
}

export interface SubmitResponse extends JobActions {
  request_id: string;
  job: Job;
  idempotency_hit: boolean;
  generation_limits?: Record<string, unknown>;
}

export interface StatusResponse extends JobActions {
  request_id: string;
  job_id: string;
  /** Queue-style spelling: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELED. */
  status: string;
  sume_status: JobState;
  queue_position: number | null;
  job?: Job;
}

export interface ResultResponse {
  request_id: string;
  job_id: string;
  status: string;
  result: { artifacts?: Artifact[]; [key: string]: unknown } | null;
  job?: Job;
}

export interface CancelResponse {
  request_id: string;
  job_id: string;
  status: string;
  canceled: boolean;
  idempotency_hit: boolean;
  job: Job;
}

export interface JobList {
  jobs: Job[];
  next_cursor?: string;
}

export interface JobEvent {
  id: string;
  type: string;
  source?: string;
  status?: string;
  message?: string;
  created_at: string;
  data?: Record<string, unknown>;
}

export interface JobEvents {
  request_id: string;
  job_id: string;
  events: JobEvent[];
}

export interface Asset {
  id: string;
  media_type: "image" | "video" | "audio" | "file";
  status: string;
  url: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
}

export interface UploadTarget {
  asset: Asset;
  upload: {
    asset_id?: string;
    /** Presigned and short-lived. Never log it. */
    url: string;
    method: string;
    /** Send exactly these with the PUT; `content-length` is signed. */
    headers: Record<string, string>;
    expires_at: string;
    max_bytes?: number;
  };
}
