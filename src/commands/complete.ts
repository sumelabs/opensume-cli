import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandSpec } from "../lib/args.ts";
import { ExitCode } from "../lib/errors.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function cacheFile(env: NodeJS.ProcessEnv): string {
  const base =
    process.platform === "win32"
      ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "opensume", "model-ids.json");
}

/** Hidden: what the completion scripts call for model ids. Never fails loudly. */
export const complete: CommandSpec = {
  name: "__complete",
  hidden: true,
  summary: "Completion candidates",
  args: [{ name: "kind", required: true, description: "models" }],
  run: async (parsed, ctx) => {
    if (parsed.args[0] !== "models") return ExitCode.Usage;
    const file = cacheFile(ctx.env);
    let ids: string[] | undefined;
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as { at: number; base: string; ids: string[] };
      if (Date.now() - cached.at < DAY_MS && cached.base === ctx.settings.baseUrl) ids = cached.ids;
    } catch {
      // No cache yet.
    }
    if (!ids) {
      try {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(3000)]);
        ids = (await ctx.client().listModels(signal)).map((m) => m.id);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ at: Date.now(), base: ctx.settings.baseUrl, ids }));
      } catch {
        return ExitCode.Ok;
      }
    }
    ctx.ui.out(ids.join("\n"));
    return ExitCode.Ok;
  },
};
