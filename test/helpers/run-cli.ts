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
