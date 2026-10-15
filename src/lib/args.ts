import type { Context } from "../context.ts";
import { UsageError } from "./errors.ts";

export type FlagType = "string" | "number" | "boolean";
export type FlagValue = string | number | boolean | string[] | number[];

export interface FlagSpec {
  readonly name: string;
  readonly short?: string;
  readonly type: FlagType;
  readonly description: string;
  /** Collect every occurrence into an array. */
  readonly multiple?: boolean;
  /** Shown in help, for example `<path>`. */
  readonly placeholder?: string;
  readonly choices?: readonly string[];
  readonly hidden?: boolean;
  /** Heading the flag is listed under in help. */
  readonly section?: string;
  /** Number flags: the smallest and largest value allowed, and whether it must be whole. */
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export interface ArgSpec {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly variadic?: boolean;
  /** Shell completion offers model ids here. */
  readonly complete?: "models";
}

export interface Parsed {
  /** The command that runs, after walking subcommands. */
  readonly command: CommandSpec;
  /** Names from the root to `command`, root excluded: `["jobs", "wait"]`. */
  readonly path: readonly string[];
  readonly args: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue | undefined>>;
}

export interface CommandSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** One line, shown in command lists. */
  readonly summary: string;
  /** Paragraphs shown on the command's own help page. */
  readonly description?: string;
  readonly args?: readonly ArgSpec[];
  readonly flags?: readonly FlagSpec[];
  readonly examples?: readonly string[];
  readonly commands?: readonly CommandSpec[];
  /** Group heading in the parent's command list. */
  readonly group?: string;
  readonly hidden?: boolean;
  /** Returns the exit code; `undefined` means success. */
  readonly run?: (parsed: Parsed, ctx: Context) => Promise<number | undefined>;
}

// Flags never contain whitespace, so "-a dog" is text (a prompt), not a flag.
const isFlagToken = (token: string) =>
  token.startsWith("-") && token !== "-" && !/^-\d/u.test(token) && !/\s/u.test(token);

export function findSubcommand(command: CommandSpec, name: string): CommandSpec | undefined {
  return command.commands?.find((c) => c.name === name || c.aliases?.includes(name));
}

/** Flags visible at `chain`'s leaf: the root's (global) plus every level's. */
export function flagsFor(chain: readonly CommandSpec[]): FlagSpec[] {
  const seen = new Map<string, FlagSpec>();
  for (const command of chain) for (const flag of command.flags ?? []) seen.set(flag.name, flag);
  return [...seen.values()];
}

/**
 * Parse argv against a command tree. Subcommand names are matched until the
 * first positional argument; flags may appear anywhere after the command
 * that defines them, and global flags anywhere at all. `--` ends flags.
 */
export function parse(root: CommandSpec, argv: readonly string[]): Parsed {
  const chain: CommandSpec[] = [root];
  const path: string[] = [];
  const args: string[] = [];
  const flags: Record<string, FlagValue | undefined> = {};
  const leaf = () => chain[chain.length - 1] as CommandSpec;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (!isFlagToken(token)) {
      const sub = args.length === 0 ? findSubcommand(leaf(), token) : undefined;
      if (sub) {
        chain.push(sub);
        path.push(sub.name);
      } else {
        args.push(token);
      }
      continue;
    }

    const known = flagsFor(chain);
    let name: string;
    let inline: string | undefined;
    let spec: FlagSpec | undefined;
    let negated = false;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
      spec = known.find((f) => f.name === name);
      if (!spec && name.startsWith("no-")) {
        const positive = known.find((f) => f.name === name.slice(3) && f.type === "boolean");
        if (positive) {
          spec = positive;
          negated = true;
        }
      }
    } else {
      name = token.slice(1, 2);
      inline = token.length > 2 ? token.slice(2).replace(/^=/u, "") : undefined;
      spec = known.find((f) => f.short === name);
    }
    if (!spec) throw unknownFlag(token, known, path);

    let value: FlagValue;
    if (spec.type === "boolean") {
      if (inline === undefined) value = !negated;
      else if (/^(true|1|yes)$/iu.test(inline)) value = !negated;
      else if (/^(false|0|no)$/iu.test(inline)) value = negated;
      else throw new UsageError(`--${spec.name} is a switch; it takes no value (got "${inline}").`);
    } else {
      let raw = inline;
      if (raw === undefined) {
        const next = argv[i + 1];
        if (next === undefined || looksLikeKnownFlag(next, known)) {
          throw new UsageError(`--${spec.name} needs a value${spec.placeholder ? ` ${spec.placeholder}` : ""}.`);
        }
        raw = next;
        i++;
      }
      // An empty value is never meant: it is usually a shell variable that is not set
      // (`--image "$IMG"`), and dropping it would run a different, paid request.
      if (raw.trim() === "") throw emptyValue(`--${spec.name}`);
      value = spec.type === "number" ? toNumber(spec, raw) : raw;
      if (spec.choices && !spec.choices.includes(String(value))) {
        throw new UsageError(
          `--${spec.name} must be one of: ${spec.choices.join(", ")} (got "${raw}").`,
          suggestionLine(String(value), spec.choices),
        );
      }
    }

    if (spec.multiple) {
      const list = (flags[spec.name] as (string | number)[] | undefined) ?? [];
      flags[spec.name] = [...list, value as string | number] as string[] | number[];
    } else {
      flags[spec.name] = value;
    }
  }

  const command = leaf();
  checkArgs(command, args, path, flags.help === true);
  return { command, path, args, flags };
}

function emptyValue(what: string): UsageError {
  return new UsageError(`${what} is empty.`, "If it comes from a shell variable, that variable is not set.");
}

/** Unknown subcommands are errors even with --help; missing arguments are not. */
function checkArgs(command: CommandSpec, args: string[], path: string[], help: boolean) {
  const specs = command.args ?? [];
  if (!command.run && command.commands?.length) {
    if (args.length > 0) {
      const name = args[0] as string;
      const names = command.commands.filter((c) => !c.hidden).flatMap((c) => [c.name, ...(c.aliases ?? [])]);
      throw new UsageError(
        `Unknown command "${[...path, name].join(" ")}".`,
        suggestionLine(name, names) ?? `Run \`opensume ${[...path, "--help"].join(" ")}\` to see the commands.`,
      );
    }
    return;
  }
  if (help) return;
  const required = specs.filter((a) => a.required).length;
  const variadic = specs.some((a) => a.variadic);
  if (args.length < required) {
    const missing = specs[args.length] as ArgSpec;
    throw new UsageError(`Missing <${missing.name}>.`, `Run \`opensume ${[...path, "--help"].join(" ")}\`.`);
  }
  for (const [i, arg] of args.entries()) {
    if (arg.trim() !== "") continue;
    const spec = specs[Math.min(i, specs.length - 1)];
    throw emptyValue(spec ? `<${spec.name}>` : `Argument ${i + 1}`);
  }
  if (!variadic && args.length > specs.length) {
    const extra = args[specs.length] as string;
    throw new UsageError(
      `Unexpected argument "${extra}".`,
      extra.includes(" ") || specs.length === 0
        ? `Run \`opensume ${[...path, "--help"].join(" ")}\`.`
        : "Quote arguments that contain spaces.",
    );
  }
}

function toNumber(spec: FlagSpec, raw: string): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) {
    throw new UsageError(`--${spec.name} must be a number (got "${raw}").`);
  }
  if (spec.integer && !Number.isInteger(value)) {
    throw new UsageError(`--${spec.name} must be a whole number (got "${raw}").`);
  }
  const { min, max } = spec;
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    const range =
      min !== undefined && max !== undefined
        ? `from ${min} to ${max}`
        : min !== undefined
          ? `${min} or more`
          : `${max} or less`;
    throw new UsageError(`--${spec.name} must be ${range} (got ${raw}).`);
  }
  return value;
}

function looksLikeKnownFlag(token: string, known: FlagSpec[]): boolean {
  if (token.startsWith("--")) {
    const name = token.slice(2).split("=")[0] as string;
    return known.some((f) => f.name === name || (f.type === "boolean" && `no-${f.name}` === name));
  }
  return token.length === 2 && token.startsWith("-") && known.some((f) => f.short === token[1]);
}

function unknownFlag(token: string, known: FlagSpec[], path: string[]): UsageError {
  const names = known.filter((f) => !f.hidden).map((f) => `--${f.name}`);
  const bare = token.split("=")[0] as string;
  return new UsageError(
    `Unknown flag ${bare}${path.length ? ` for "opensume ${path.join(" ")}"` : ""}.`,
    suggestionLine(bare, names) ??
      `Run \`opensume ${[...path, "--help"].join(" ")}\` to see the flags. Text that starts with "-" goes after --.`,
  );
}

/** "Did you mean …?" when something is within two edits of the input. */
export function suggestionLine(input: string, candidates: readonly string[]): string | undefined {
  const best = closest(input, candidates);
  return best ? `Did you mean ${best}?` : undefined;
}

export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = Math.max(2, Math.floor(input.length / 4));
  return bestDistance <= limit ? best : undefined;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}
