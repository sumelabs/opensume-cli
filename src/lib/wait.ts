import { sleep as defaultSleep, type SumeClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import type { StatusResponse } from "../api/types.ts";
import { CliError, ExitCode } from "./errors.ts";

export interface WaitOptions {
  /** Give up after this long; the job keeps running on Sume's side. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Called with every status read, for progress display. */
  onStatus?: (status: StatusResponse) => void;
  /** A transient read failure the loop is riding out. */
  onRetry?: (error: Error) => void;
  /** The delay chosen before the next read, and the API's own hint. */
  onDelay?: (delaySeconds: number, hintSeconds: number | null) => void;
  /** Awaited after every status read, before waiting again (`--logs` reads events here). */
  onPoll?: (status: StatusResponse) => Promise<void>;
  /** Seconds before the first read, usually the submit's `next_poll_after_seconds`. */
  firstDelaySeconds?: number | null | undefined;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const MIN_DELAY_S = 1;
const DEFAULT_DELAY_S = 2;

/**
 * The longest gap between reads, by how long the job has run. The API's
 * `next_poll_after_seconds` can ask for 30 s while a job is running, but a
 * job can finish well inside that window, so following it blindly turns a
 * 13 s image into a 33 s wait. Shorter hints are always honored.
 */
export function maxDelaySeconds(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 5;
  if (elapsedMs < 600_000) return 10;
  return 15;
}

/**
 * Poll `GET /v1/jobs/{id}/status` until the job is terminal, waiting between
 * reads as the API asks (`next_poll_after_seconds`), up to a cap that grows
 * with the job's age. Transient read failures (network, 429, 5xx) do not end
 * the wait; the deadline does.
 */
export async function waitForJob(client: SumeClient, jobId: string, options: WaitOptions): Promise<StatusResponse> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + options.timeoutMs;
  let delayMs = Math.min(Math.max(options.firstDelaySeconds ?? 0, 0), maxDelaySeconds(0)) * 1000;

  for (;;) {
    if (delayMs > 0) {
      const remaining = deadline - now();
      if (remaining <= 0) throw timeoutError(jobId, options.timeoutMs);
      await sleep(Math.min(delayMs, remaining), options.signal);
    }
    let status: StatusResponse;
    let pollAfter: number | undefined;
    try {
      const res = await client.getStatus(jobId, options.signal);
      status = res.data;
      const header = Number(res.headers.get("x-sume-poll-after"));
      pollAfter = Number.isFinite(header) && header > 0 ? header : undefined;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!isTransient(error)) throw error;
      options.onRetry?.(error as Error);
      delayMs = 5000;
      continue;
    }
    options.onStatus?.(status);
    if (status.terminal) return status;
    await options.onPoll?.(status);
    if (now() >= deadline) throw timeoutError(jobId, options.timeoutMs);
    const hint = status.next_poll_after_seconds ?? pollAfter ?? status.recommended_poll_interval_seconds ?? null;
    const delayS = clampDelay(hint ?? DEFAULT_DELAY_S, maxDelaySeconds(now() - started));
    options.onDelay?.(delayS, hint);
    delayMs = delayS * 1000;
  }
}

function clampDelay(seconds: number, max: number): number {
  if (!Number.isFinite(seconds)) return Math.min(DEFAULT_DELAY_S, max);
  return Math.min(Math.max(seconds, MIN_DELAY_S), max);
}

function isTransient(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 429 || error.status >= 500;
  return error instanceof CliError && error.code === "network_error";
}

function timeoutError(jobId: string, timeoutMs: number): CliError {
  return new CliError(`Stopped waiting after ${Math.round(timeoutMs / 1000)}s; job ${jobId} is still running.`, {
    exitCode: ExitCode.Timeout,
    code: "wait_timeout",
    hint: `Pick it up later with \`opensume jobs wait ${jobId}\`.`,
  });
}

/** `90`, `90s`, `5m`, `1h30m` → milliseconds. */
export function parseDuration(text: string): number {
  const trimmed = text.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/u.test(trimmed) && Number(trimmed) > 0) return Number(trimmed) * 1000;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gu;
  let total = 0;
  let consumed = "";
  for (const match of trimmed.matchAll(pattern)) {
    const value = Number(match[1]);
    const unit = match[2];
    total += unit === "ms" ? value : unit === "s" ? value * 1000 : unit === "m" ? value * 60_000 : value * 3_600_000;
    consumed += match[0];
  }
  if (!consumed || consumed !== trimmed || total <= 0) {
    throw new CliError(`Not a duration: "${text}". Use seconds or a unit, like 90s, 10m or 1h.`, {
      exitCode: ExitCode.Usage,
      code: "usage_error",
    });
  }
  return total;
}
