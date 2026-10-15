/**
 * Terminal output. Results go to stdout; progress, notes and errors go to
 * stderr, so `opensume … > file` and pipes stay clean. Color and motion
 * appear only on a TTY, and never under NO_COLOR or `--no-color`.
 */

export interface Stream {
  write(chunk: string): boolean;
  isTTY?: boolean;
  columns?: number;
}

export interface UiOptions {
  stdout: Stream;
  stderr: Stream;
  color: boolean;
  /** Animate progress (stderr is a TTY and output is for a person). */
  interactive: boolean;
  quiet: boolean;
  verbose: boolean;
}

type Paint = (text: string) => string;

export interface Palette {
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  blue: Paint;
  cyan: Paint;
  magenta: Paint;
}

const sgr =
  (open: number, close: number): Paint =>
  (text) =>
    `\u001b[${open}m${text}\u001b[${close}m`;
const plain: Paint = (text) => text;

export function palette(enabled: boolean): Palette {
  if (!enabled) {
    return {
      bold: plain,
      dim: plain,
      red: plain,
      green: plain,
      yellow: plain,
      blue: plain,
      cyan: plain,
      magenta: plain,
    };
  }
  return {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    blue: sgr(34, 39),
    cyan: sgr(36, 39),
    magenta: sgr(35, 39),
  };
}

/** Whether to color a stream, by the usual conventions. */
export function colorEnabled(stream: Stream, env: NodeJS.ProcessEnv, flag: boolean | undefined): boolean {
  if (flag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI = /\u001b\[[0-9;]*m/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI_AT_START = /^\u001b\[[0-9;]*m/u;
export const visibleLength = (text: string) => text.replace(ANSI, "").length;

export class Ui {
  readonly c: Palette;
  readonly options: UiOptions;
  #spinner: Spinner | undefined;

  constructor(options: UiOptions) {
    this.options = options;
    this.c = palette(options.color);
  }

  get interactive(): boolean {
    return this.options.interactive;
  }

  get width(): number {
    return Math.max(40, Math.min(this.options.stderr.columns ?? this.options.stdout.columns ?? 100, 120));
  }

  /** A result line on stdout. */
  out(line = ""): void {
    this.#clearSpinner();
    this.options.stdout.write(`${line}\n`);
  }

  /** A progress or info line on stderr; hidden by `--quiet`. */
  info(line = ""): void {
    if (this.options.quiet) return;
    this.#clearSpinner();
    this.options.stderr.write(`${line}\n`);
  }

  success(line: string): void {
    this.info(`${this.c.green("✓")} ${line}`);
  }

  warn(line: string): void {
    this.#clearSpinner();
    this.options.stderr.write(`${this.c.yellow("!")} ${line}\n`);
  }

  /** Only with `--verbose`. */
  debug(line: string): void {
    if (!this.options.verbose) return;
    this.#clearSpinner();
    this.options.stderr.write(`${this.c.dim(line)}\n`);
  }

  error(message: string, hint?: string): void {
    this.#clearSpinner();
    this.options.stderr.write(`${this.c.red("✗")} ${message}\n`);
    if (hint) this.options.stderr.write(`  ${this.c.dim(hint)}\n`);
  }

  /** Print a value as JSON on stdout (`--json`). */
  json(value: unknown): void {
    this.#clearSpinner();
    this.options.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** Start (or retarget) the one progress line. No-op when not interactive. */
  spin(text: string): void {
    if (this.options.quiet) return;
    if (!this.options.interactive) return;
    if (!this.#spinner) this.#spinner = new Spinner(this.options.stderr, this.c);
    this.#spinner.update(text);
  }

  stopSpinner(): void {
    this.#spinner?.stop();
    this.#spinner = undefined;
  }

  #clearSpinner(): void {
    this.#spinner?.clear();
  }

  /**
   * Align rows into columns. On a terminal, rows are cut to its width; in a
   * pipe they are kept whole, for whatever reads them.
   */
  table(header: string[], rows: string[][]): void {
    const widths = header.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ""))));
    const max = this.options.stdout.isTTY ? (this.options.stdout.columns ?? 0) : 0;
    const line = (cells: string[]) => {
      const text = cells
        .map((cell, i) => (i === cells.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - visibleLength(cell))))
        .join("  ")
        .trimEnd();
      return max > 0 && visibleLength(text) > max ? truncate(text, max) : text;
    };
    this.out(this.c.dim(line(header)));
    for (const row of rows) this.out(line(row));
  }
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class Spinner {
  #stream: Stream;
  #c: Palette;
  #text = "";
  #frame = 0;
  #timer: NodeJS.Timeout | undefined;
  #drawn = false;

  constructor(stream: Stream, c: Palette) {
    this.#stream = stream;
    this.#c = c;
    this.#stream.write("\u001b[?25l");
    this.#timer = setInterval(() => this.#draw(), 80);
    this.#timer.unref();
  }

  update(text: string): void {
    this.#text = text;
    this.#draw();
  }

  clear(): void {
    if (this.#drawn) this.#stream.write("\r\u001b[2K");
    this.#drawn = false;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.clear();
    this.#stream.write("\u001b[?25h");
  }

  #draw(): void {
    const frame = FRAMES[this.#frame++ % FRAMES.length] as string;
    const columns = this.#stream.columns ?? 100;
    let text = this.#text;
    if (visibleLength(text) > columns - 3) text = `${text.replace(ANSI, "").slice(0, columns - 4)}…`;
    this.#stream.write(`\r\u001b[2K${this.#c.cyan(frame)} ${text}`);
    this.#drawn = true;
  }
}

// Formatting.

/** Cut to `width` visible characters, ending in "…", keeping color codes intact. */
export function truncate(text: string, width: number): string {
  let visible = 0;
  let out = "";
  for (let i = 0; i < text.length; ) {
    const code = ANSI_AT_START.exec(text.slice(i));
    if (code) {
      out += code[0];
      i += code[0].length;
      continue;
    }
    if (visible === width - 1) return `${out}…\u001b[0m`;
    out += text[i];
    visible++;
    i++;
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * Dollars as the API prints them: its strings verbatim (`"0.0500"` stays
 * `$0.0500`); numbers as cents when they are whole cents (`0.5` → `$0.50`),
 * else to at most four places (`0.0025` → `$0.0025`).
 */
export function formatUsd(usd: string | number): string {
  if (typeof usd === "string") return `$${usd}`;
  if (!Number.isFinite(usd)) return `$${usd}`;
  const cents = usd.toFixed(2);
  return Number(cents) === usd ? `$${cents}` : `$${usd.toFixed(4).replace(/0{1,2}$/u, "")}`;
}

/** "3 minutes ago"-style age for list views. */
export function formatAge(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Wrap plain text to `width`, keeping words whole. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      if (line && visibleLength(line) + 1 + visibleLength(word) > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines;
}
