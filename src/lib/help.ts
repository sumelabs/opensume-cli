import type { ArgSpec, CommandSpec, FlagSpec } from "./args.ts";
import { type Palette, visibleLength, wrap } from "./ui.ts";

const usageArg = (arg: ArgSpec) => {
  const name = `${arg.name}${arg.variadic ? "..." : ""}`;
  return arg.required ? `<${name}>` : `[${name}]`;
};

function flagLabel(flag: FlagSpec): string {
  const short = flag.short ? `-${flag.short}, ` : "    ";
  const value = flag.type === "boolean" ? "" : ` ${flag.placeholder ?? (flag.type === "number" ? "<n>" : "<value>")}`;
  return `${short}--${flag.name}${value}`;
}

function rows(entries: [string, string][], c: Palette, width: number, minLabelWidth = 0): string[] {
  const labelWidth = Math.min(Math.max(minLabelWidth, ...entries.map(([label]) => visibleLength(label))), 34);
  const textWidth = Math.max(width - labelWidth - 6, 30);
  const lines: string[] = [];
  for (const [label, text] of entries) {
    const wrapped = wrap(text, textWidth);
    const pad = " ".repeat(Math.max(labelWidth - visibleLength(label), 0));
    if (visibleLength(label) > labelWidth) {
      lines.push(`  ${label}`);
      for (const line of wrapped) lines.push(`  ${" ".repeat(labelWidth)}  ${c.dim(line)}`);
      continue;
    }
    lines.push(`  ${label}${pad}  ${c.dim(wrapped[0] ?? "")}`);
    for (const line of wrapped.slice(1)) lines.push(`  ${" ".repeat(labelWidth)}  ${c.dim(line)}`);
  }
  return lines;
}

/** The help page for `chain`'s last command. `chain[0]` is the root. */
export function renderHelp(chain: readonly CommandSpec[], c: Palette, width: number): string {
  const root = chain[0] as CommandSpec;
  const command = chain[chain.length - 1] as CommandSpec;
  const isRoot = chain.length === 1;
  const names = chain.slice(1).map((cmd) => cmd.name);
  const prog = ["opensume", ...names].join(" ");
  const out: string[] = [];

  out.push(isRoot ? `${c.bold("opensume")} — ${command.summary}` : `${c.bold(prog)} — ${command.summary}`);
  if (command.description) {
    out.push("");
    for (const line of wrap(command.description, Math.min(width, 100) - 2)) out.push(line ? `${line}` : "");
  }

  const subcommands = (command.commands ?? []).filter((cmd) => !cmd.hidden);
  if (command.aliases?.length) out.push("", `${c.bold("Aliases")}  ${command.aliases.join(", ")}`);
  out.push("", c.bold("Usage"));
  if (subcommands.length && !command.run) {
    out.push(`  ${prog} <command> [flags]`);
  } else {
    const args = (command.args ?? []).map(usageArg).join(" ");
    out.push(`  ${prog}${args ? ` ${args}` : ""} [flags]`);
  }

  if (command.args?.length) {
    out.push("", c.bold("Arguments"));
    out.push(
      ...rows(
        command.args.map((a) => [a.name, a.description]),
        c,
        width,
      ),
    );
  }

  if (subcommands.length) {
    const groups = new Map<string, CommandSpec[]>();
    for (const sub of subcommands) {
      const group = sub.group ?? "Commands";
      groups.set(group, [...(groups.get(group) ?? []), sub]);
    }
    const labelWidth = Math.max(...subcommands.map((sub) => sub.name.length));
    for (const [group, list] of groups) {
      out.push("", c.bold(group));
      out.push(
        ...rows(
          list.map((sub) => [sub.name, sub.summary]),
          c,
          width,
          labelWidth,
        ),
      );
    }
  }

  const own = (command.flags ?? []).filter((f) => !f.hidden);
  if (!isRoot && own.length) {
    const sections = new Map<string, FlagSpec[]>();
    for (const flag of own) {
      const section = flag.section ?? "Flags";
      sections.set(section, [...(sections.get(section) ?? []), flag]);
    }
    const labelWidth = Math.max(...own.map((f) => flagLabel(f).length));
    for (const [section, flags] of sections) {
      out.push("", c.bold(section));
      out.push(
        ...rows(
          flags.map((f) => [flagLabel(f), describeFlag(f)]),
          c,
          width,
          labelWidth,
        ),
      );
    }
  }

  // Flags inherited from intermediate commands (for example `jobs`), then globals.
  const inherited = chain
    .slice(1, -1)
    .flatMap((cmd) => cmd.flags ?? [])
    .filter((f) => !f.hidden);
  if (inherited.length)
    out.push(
      ...rows(
        inherited.map((f) => [flagLabel(f), describeFlag(f)]),
        c,
        width,
      ),
    );

  const globals = (root.flags ?? []).filter((f) => !f.hidden);
  if (globals.length) {
    out.push("", c.bold(isRoot ? "Flags" : "Global flags"));
    out.push(
      ...rows(
        globals.map((f) => [flagLabel(f), describeFlag(f)]),
        c,
        width,
      ),
    );
  }

  if (command.examples?.length) {
    out.push("", c.bold("Examples"));
    for (const example of command.examples) {
      out.push(example.startsWith("#") ? `  ${c.dim(example)}` : `  ${c.dim("$")} ${example}`);
    }
  }

  if (isRoot) {
    out.push("", `Run ${c.cyan("opensume <command> --help")} for a command's flags.`);
    out.push(`Docs: ${c.cyan("https://api.dev.sume.com/docs")}`);
  }
  return `${out.join("\n")}\n`;
}

function describeFlag(flag: FlagSpec): string {
  const notes: string[] = [];
  if (flag.choices) notes.push(`one of: ${flag.choices.join(", ")}`);
  if (flag.multiple) notes.push("repeatable");
  return notes.length ? `${flag.description} (${notes.join("; ")})` : flag.description;
}
