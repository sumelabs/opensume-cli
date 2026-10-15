import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { root } from "../src/cli.ts";
import { completionEntries, completionScript } from "../src/commands/completion.ts";
import { runCli } from "./helpers/run-cli.ts";

describe("help", () => {
  it("lists every command on the root page", async () => {
    const res = await runCli([]);
    expect(res.code).toBe(0);
    for (const command of ["run", "estimate", "upload", "models", "jobs", "auth", "completion", "update", "version"]) {
      expect(res.stdout).toMatch(new RegExp(`^  ${command} `, "mu"));
    }
    expect(res.stdout).not.toContain("__complete");
  });

  it("shows a command's sections, flags and examples", async () => {
    const res = await runCli(["run", "--help"]);
    for (const heading of [
      "Usage",
      "Arguments",
      "Inputs",
      "Settings",
      "Output",
      "Submit",
      "Global flags",
      "Examples",
    ]) {
      expect(res.stdout).toContain(`\n${heading}\n`);
    }
    expect(res.stdout).toContain("-o, --output <path>");
    expect((await runCli(["help", "jobs", "wait"])).stdout).toContain("opensume jobs wait — ");
  });

  it("prints a machine-readable manifest generated from the same specs", async () => {
    const res = await runCli(["--help", "--json"]);
    const manifest = res.json<{
      commands: { command: string; commands?: { command: string }[] }[];
      exit_codes: Record<string, string>;
    }>();
    const names = manifest.commands.map((c) => c.command);
    expect(names).toContain("opensume run");
    expect(manifest.commands.find((c) => c.command === "opensume jobs")?.commands?.map((c) => c.command)).toContain(
      "opensume jobs wait",
    );
    expect(manifest.exit_codes).toMatchObject({ 0: "Ok", 2: "Usage", 3: "Auth", 5: "JobFailed", 130: "Interrupted" });
  });

  it("prints the version", async () => {
    expect((await runCli(["--version"])).stdout).toMatch(/^opensume \d+\.\d+\.\d+\n$/u);
    expect((await runCli(["version", "--json"])).json()).toHaveProperty("version");
  });
});

describe("completion", () => {
  it("covers every command path, aliases included", () => {
    const paths = completionEntries(root).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["", "run", "jobs", "jobs wait", "job wait", "auth login"]));
    expect(completionEntries(root).find((e) => e.path === "run")?.models).toBe(true);
    expect(completionEntries(root).find((e) => e.path === "models")?.models).toBe(true);
  });

  it.runIf(process.platform !== "win32")("emits a bash script that parses and follows aliases", () => {
    const script = completionScript("bash", root);
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    const complete = (words: string[]) =>
      spawnSync(
        "bash",
        [
          "-c",
          `${script}\nCOMP_WORDS=(${words.join(" ")}); COMP_CWORD=${words.length - 1}; _opensume; echo "\${COMPREPLY[*]}"`,
        ],
        { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
      ).stdout.trim();
    expect(complete(["opensume", "ru"])).toBe("run");
    expect(complete(["opensume", "job", "wa"])).toBe("wait");
    expect(complete(["opensume", "run", "--dur"])).toBe("--duration");
  });

  it("emits fish completions", () => {
    expect(completionScript("fish", root)).toContain('complete -c opensume -n "__fish_use_subcommand" -a run');
  });
});

describe("tables", () => {
  it("cuts rows to a terminal's width but keeps them whole in a pipe", async () => {
    const { Ui, truncate } = await import("../src/lib/ui.ts");
    const { Capture } = await import("./helpers/run-cli.ts");
    expect(truncate("abcdefghij", 5)).toBe("abcd…\u001b[0m");
    expect(truncate("\u001b[1mabcdef\u001b[22m", 4)).toBe("\u001b[1mabc…\u001b[0m");
    const row = ["a-model", "video", "text, image, reference, video, audio"];
    for (const tty of [true, false]) {
      const stdout = new Capture(tty);
      stdout.columns = 30;
      new Ui({ stdout, stderr: new Capture(), color: false, interactive: false, quiet: false, verbose: false }).table(
        ["MODEL", "KIND", "INPUTS"],
        [row],
      );
      const line = stdout.text.split("\n")[1] ?? "";
      expect(line.endsWith("…\u001b[0m")).toBe(tty);
    }
  });
});

describe("money", () => {
  it("prints API prices verbatim and flag amounts as cents", async () => {
    const { formatUsd } = await import("../src/lib/ui.ts");
    expect(formatUsd("0.0500")).toBe("$0.0500");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(2)).toBe("$2.00");
    expect(formatUsd(0.0025)).toBe("$0.0025");
    expect(formatUsd(0.001)).toBe("$0.001");
  });
});
