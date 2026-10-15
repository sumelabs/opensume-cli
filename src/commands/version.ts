import type { CommandSpec } from "../lib/args.ts";
import { ExitCode } from "../lib/errors.ts";
import { VERSION } from "../version.ts";

export function versionInfo() {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return {
    version: VERSION,
    runtime: bun ? `bun ${bun}` : `node ${process.versions.node}`,
    platform: process.platform,
    arch: process.arch,
  };
}

export const version: CommandSpec = {
  name: "version",
  group: "Setup",
  summary: "Print the CLI version",
  run: async (_parsed, ctx) => {
    const info = versionInfo();
    if (ctx.json) ctx.ui.json(info);
    else ctx.ui.out(`opensume ${info.version} ${ctx.ui.c.dim(`(${info.runtime}, ${info.platform} ${info.arch})`)}`);
    return ExitCode.Ok;
  },
};
