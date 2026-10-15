import { sleep as defaultSleep, SumeClient } from "./api/client.ts";
import type { Settings } from "./lib/config.ts";
import type { Ui } from "./lib/ui.ts";
import { VERSION } from "./version.ts";

/** What every command receives besides its parsed arguments. */
export interface Context {
  ui: Ui;
  /** `--json`: one JSON document on stdout, nothing else. */
  json: boolean;
  settings: Settings;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Aborted on Ctrl-C. Pass it to anything that waits. */
  signal: AbortSignal;
  userAgent: string;
  /** Every wait goes through this, so tests can skip the clock. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The job this command is following, so an error or interrupt can name it. */
  jobId: string | undefined;
  /** The Idempotency-Key of a submit in flight, for the same reason. */
  idempotencyKey: string | undefined;
  client(): SumeClient;
}

export function userAgent(): string {
  return `opensume-cli/${VERSION} (node ${process.versions.node}; ${process.platform} ${process.arch})`;
}

export function createContext(options: {
  ui: Ui;
  json: boolean;
  settings: Settings;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Context {
  const agent = userAgent();
  const sleep = options.sleep ?? defaultSleep;
  let client: SumeClient | undefined;
  return {
    ui: options.ui,
    json: options.json,
    settings: options.settings,
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    userAgent: agent,
    sleep,
    jobId: undefined,
    idempotencyKey: undefined,
    client() {
      client ??= new SumeClient({
        baseUrl: options.settings.baseUrl,
        apiKey: options.settings.apiKey,
        userAgent: agent,
        sleep,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        onResponse: ({ method, url, status, requestId, ms, attempt }) => {
          const path = new URL(url).pathname;
          options.ui.debug(
            `${method} ${path} → ${status} ${ms}ms${requestId ? ` ${requestId}` : ""}${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
          );
        },
      });
      return client;
    },
  };
}
