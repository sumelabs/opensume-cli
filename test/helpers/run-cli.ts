import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import type { Stream } from "../../src/lib/ui.ts";

export class Capture implements Stream {
  text = "";
  isTTY: boolean;
  columns = 100;
  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** Tests never reach GitHub or the real media host; everything else goes to the mock API. */
const offlineFetch: typeof globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.github.com/")) {
    return new Response(JSON.stringify({ tag_name: "v0.1.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith("https://media.sume.com/")) return new Response(null, { status: 404 });
  return globalThis.fetch(input, init);
};

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON, for `--json` runs. */
  json<T = Record<string, unknown>>(): T;
}

export function tempDir(prefix = "opensume-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run the CLI in-process against `baseUrl`, with an isolated config dir and no real waiting. */
export async function runCli(
  args: string[],
  options: { baseUrl?: string; key?: string | null; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<CliResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const env: NodeJS.ProcessEnv = {
    OPENSUME_CONFIG_DIR: tempDir("opensume-config-"),
    XDG_CACHE_HOME: tempDir("opensume-cache-"),
    NO_COLOR: "1",
    ...(options.baseUrl ? { SUME_API_BASE_URL: options.baseUrl } : {}),
    ...(options.key ? { SUME_API_KEY: options.key } : {}),
    ...options.env,
  };
  const code = await main({
    argv: args,
    env,
    cwd: options.cwd ?? tempDir(),
    stdout,
    stderr,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    fetch: offlineFetch,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    code,
    stdout: stdout.text,
    stderr: stderr.text,
    json<T>() {
      return JSON.parse(stdout.text) as T;
    },
  };
}
