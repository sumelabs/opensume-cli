/**
 * Exit codes are part of the CLI's contract: scripts and agents branch on
 * them, so a code never changes meaning once released. The README lists them.
 */
export const ExitCode = {
  Ok: 0,
  /** Anything not covered below: network failure, unexpected server error. */
  Error: 1,
  /** The command line itself is wrong: unknown flag, missing argument. */
  Usage: 2,
  /** No key, a wrong or revoked key, or a route the key may not call. */
  Auth: 3,
  /** The API refused the request: invalid input, unknown model or job. */
  Rejected: 4,
  /** The job ended `failed` or `canceled`. */
  JobFailed: 5,
  /** `--timeout` passed while the job was still running. */
  Timeout: 6,
  /** The balance cannot cover the price, or the price is over `--max-usd`. */
  Funds: 7,
  /** Rate limit or concurrency cap. Retry later. */
  RateLimited: 8,
  /** Stopped with Ctrl-C, or told to stop (SIGTERM, SIGHUP). The job keeps running. */
  Interrupted: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface CliErrorOptions {
  exitCode?: ExitCode;
  /** A stable, machine-readable code, printed in `--json` mode. */
  code?: string;
  /** One line telling the person what to do next. */
  hint?: string | undefined;
  cause?: unknown;
}

/** An error the CLI expects and explains, as opposed to a crash. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly hint: string | undefined;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.exitCode ?? ExitCode.Error;
    this.code = options.code ?? "error";
    this.hint = options.hint;
  }
}

/** The command line is wrong. Printed with a pointer to `--help`. */
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.Usage, code: "usage_error", hint });
    this.name = "UsageError";
  }
}
