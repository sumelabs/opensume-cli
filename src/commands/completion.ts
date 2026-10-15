import type { CommandSpec, FlagSpec } from "../lib/args.ts";
import { ExitCode, UsageError } from "../lib/errors.ts";

const SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SHELLS)[number];

export function completionCommand(getRoot: () => CommandSpec): CommandSpec {
  return {
    name: "completion",
    group: "Setup",
    summary: "Print a shell completion script (bash, zsh, fish)",
    description: "Completes commands, flags and model ids. Model ids come from the open catalog, cached for a day.",
    args: [{ name: "shell", required: true, description: SHELLS.join(", ") }],
    examples: [
      "# bash, in ~/.bashrc",
      'eval "$(opensume completion bash)"',
      "# zsh, in ~/.zshrc",
      'eval "$(opensume completion zsh)"',
      "# fish",
      "opensume completion fish > ~/.config/fish/completions/opensume.fish",
    ],
    run: async (parsed, ctx) => {
      const shell = parsed.args[0] as Shell;
      if (!SHELLS.includes(shell))
        throw new UsageError(`No completion for "${shell}". Pick one of: ${SHELLS.join(", ")}.`);
      const script = completionScript(shell, getRoot());
      if (ctx.json) ctx.ui.json({ shell, script });
      else ctx.ui.out(script);
      return ExitCode.Ok;
    },
  };
}

interface Entry {
  /** Command words after `opensume`, aliases included as their own entries. */
  path: string;
  /** Subcommands to offer. */
  commands: string[];
  /** Subcommand names and aliases, to follow what was typed. */
  names: string[];
  flags: string[];
  /** The first argument is a model id. */
  models: boolean;
}

export function completionEntries(root: CommandSpec): Entry[] {
  const out: Entry[] = [];
  const walk = (command: CommandSpec, paths: string[][], inherited: readonly FlagSpec[]) => {
    const flags = [...inherited, ...(command.flags ?? [])].filter((f) => !f.hidden);
    const subs = (command.commands ?? []).filter((c) => !c.hidden);
    for (const path of paths) {
      out.push({
        path: path.join(" "),
        commands: subs.map((c) => c.name),
        names: subs.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
        flags: flags.map((f) => `--${f.name}`),
        models: command.args?.[0]?.complete === "models",
      });
    }
    for (const sub of subs) {
      const names = [sub.name, ...(sub.aliases ?? [])];
      walk(
        sub,
        paths.flatMap((p) => names.map((n) => [...p, n])),
        flags,
      );
    }
  };
  walk(root, [[]], []);
  return out;
}

export function completionScript(shell: Shell, root: CommandSpec): string {
  const all = completionEntries(root);
  return shell === "fish" ? fish(all) : posix(all, shell);
}

function posix(all: Entry[], shell: "bash" | "zsh"): string {
  const subs = all.map((e) => `    "${e.path}") echo "${e.names.join(" ")}" ;;`).join("\n");
  const words = all
    .map((e) => `    "${e.path}") candidates="${[...e.commands, ...e.flags].join(" ")}"; models=${e.models ? 1 : 0} ;;`)
    .join("\n");
  const body = `# opensume completion for ${shell}
_opensume_subcommands() {
  case "$1" in
${subs}
  esac
}
_opensume() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmdpath="" word i candidates="" models=0
  for ((i = 1; i < COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    [[ "$word" == -* ]] && continue
    if [[ " $(_opensume_subcommands "$cmdpath") " == *" $word "* ]]; then
      cmdpath="\${cmdpath:+$cmdpath }$word"
    else
      break
    fi
  done
  case "$cmdpath" in
${words}
  esac
  if [[ "$models" == 1 && "$cur" != -* ]]; then
    candidates="$candidates $(opensume __complete models 2>/dev/null)"
  fi
  COMPREPLY=($(compgen -W "$candidates" -- "$cur"))
}`;
  const register = "complete -o default -F _opensume opensume";
  if (shell === "bash") return `${body}\n${register}`;
  // zsh runs the bash function through bashcompinit, which needs compinit.
  const zshSetup = [
    "(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }",
    "autoload -U +X bashcompinit && bashcompinit",
  ].join("\n");
  return `${zshSetup}\n${body}\n${register}`;
}

function fish(all: Entry[]): string {
  // No global -f: flags such as --image and --video should still complete file names.
  const lines = ["# opensume completion for fish"];
  for (const entry of all) {
    const words = entry.path ? entry.path.split(" ") : [];
    const condition = words.length ? `__fish_seen_subcommand_from ${words[words.length - 1]}` : "__fish_use_subcommand";
    for (const sub of entry.commands) lines.push(`complete -c opensume -n "${condition}" -f -a ${sub}`);
    if (!entry.path) continue;
    for (const flag of entry.flags) lines.push(`complete -c opensume -n "${condition}" -l ${flag.slice(2)}`);
    if (entry.models)
      lines.push(`complete -c opensume -n "${condition}" -a "(opensume __complete models 2>/dev/null)"`);
  }
  return [...new Set(lines)].join("\n");
}
