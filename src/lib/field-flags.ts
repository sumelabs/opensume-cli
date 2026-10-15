import type { Router } from "../api/client.ts";
import { closest, type FlagSpec } from "./args.ts";
import { UsageError } from "./errors.ts";
import { isCliOwned, routerSchema } from "./schema.ts";

export interface FieldFlagCommand {
  /** The command's path, like "run", for messages. */
  readonly name: string;
  /** Every flag the command takes, global flags included. */
  readonly flags: readonly FlagSpec[];
}

/**
 * Any request field as a flag, the way genmedia takes `--<param> value`:
 * `opensume run <model> "…" --rendering_speed fast --captions.style glass`. A flag the
 * command does not define, whose name (with `-` read as `_`) is a field of
 * the model's router, becomes `--set field=value`, so it is typed and
 * checked like `--set`. A true/false field alone means true, and
 * `--no-<field>` sets it to false.
 *
 * `commandFor` names the commands that take fields (`run`, `estimate`).
 * Everything else in argv is left alone for the parser.
 */
export function expandFieldFlags(
  argv: readonly string[],
  commandFor: (name: string) => FieldFlagCommand | undefined,
  routerFor: (model: string) => Router | undefined,
  /** Global flags that take a value, like `--base-url`. */
  globalValueFlags: readonly string[] = [],
): string[] {
  // The command is the first word, past any global flag and its value (`--base-url <url> run …`).
  let start = -1;
  for (let i = 0; i < argv.length && start === -1; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("-")) start = i;
    else if (globalValueFlags.includes(token)) i++;
  }
  const command = start === -1 ? undefined : commandFor(argv[start] as string);
  if (!command) return [...argv];

  const takesValue = (name: string) => command.flags.some((f) => f.name === name && f.type !== "boolean");
  // `-o out.png`: a short flag whose value is the next token.
  const shortTakesValue = (token: string) =>
    token.length === 2 && command.flags.some((f) => f.short === token[1] && f.type !== "boolean");
  // The parser's rule: text with whitespace is never a flag, so prompts may start with "-".
  const isText = (token: string) => !token.startsWith("-") || token === "-" || /\s/u.test(token);
  const isKnown = (name: string) =>
    command.flags.some((f) => f.name === name || (f.type === "boolean" && `no-${f.name}` === name));

  // The model is the command's first positional argument.
  let model: string | undefined;
  for (let i = start + 1; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") break;
    if (!isText(token)) {
      if ((token.startsWith("--") && !token.includes("=") && takesValue(token.slice(2))) || shortTakesValue(token)) i++;
      continue;
    }
    model = token;
    break;
  }
  const router = model ? routerFor(model) : undefined;
  const fields = new Map(
    (router ? [router] : (["image", "video"] as const)).flatMap((r) => Object.entries(routerSchema(r).fields)),
  );

  const out = argv.slice(0, start + 1);
  for (let i = start + 1; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      out.push(...argv.slice(i));
      break;
    }
    if (isText(token) || !token.startsWith("--")) {
      out.push(token);
      if (shortTakesValue(token) && i + 1 < argv.length) out.push(argv[++i] as string);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (isKnown(name)) {
      out.push(token);
      if (inline === undefined && takesValue(name) && i + 1 < argv.length) out.push(argv[++i] as string);
      continue;
    }

    const path = name.replaceAll("-", "_");
    const negated = path.startsWith("no_") && fields.get(path.slice(3))?.type === "boolean";
    const key = negated ? path.slice(3) : path;
    const top = key.split(".")[0] as string;
    const field = fields.get(top);
    if (top === "model") {
      throw new UsageError(
        `--${name}: the model is the first argument, not a flag.`,
        `opensume ${command.name} <model> …`,
      );
    }
    if (!field || isCliOwned(top)) {
      // Not a field either: a near miss gets the closest flag or field.
      const candidates = [
        ...command.flags.filter((f) => !f.hidden).map((f) => `--${f.name}`),
        ...[...fields.keys()].filter((f) => !isCliOwned(f)).map((f) => `--${f}`),
      ];
      const guess = closest(`--${name}`, candidates);
      throw new UsageError(
        `Unknown flag --${name} for "opensume ${command.name}".`,
        guess
          ? `Did you mean ${guess}?`
          : `Run \`opensume schema ${model ?? "<model>"}\` for the fields this model takes; each one works as a flag.`,
      );
    }
    if (negated) {
      if (inline !== undefined) throw new UsageError(`--${name} is a switch; it takes no value (got "${inline}").`);
      out.push("--set", `${key}=false`);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      const isSwitch = key === top && field.type === "boolean";
      if (
        next !== undefined &&
        !(next.startsWith("--") && next.length > 2) &&
        (!isSwitch || /^(true|false)$/iu.test(next))
      ) {
        value = next;
        i++;
      } else if (isSwitch) {
        value = "true";
      } else {
        throw new UsageError(`--${name} needs a value.`, `Run \`opensume schema ${model ?? "<model>"}\` for its type.`);
      }
    }
    out.push("--set", `${key}=${value}`);
  }
  return out;
}
