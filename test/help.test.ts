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
    const fish = completionScript("fish", root);
    expect(fish).toContain('complete -c opensume -n "__fish_use_subcommand" -f -a run');
    // No global -f: file names still complete for --image and friends.
    expect(fish).not.toMatch(/^complete -c opensume -f$/mu);
  });
});

describe("tables", () => {
  it("cuts rows to a terminal's width but keeps them whole in a pipe", async () => {
    const { Ui, truncate } = await import("../src/lib/ui.ts");
    const { Capture } = await import("./helpers/run-cli.ts");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
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
      expect(line.endsWith("…")).toBe(tty);
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

describe("review fixes", () => {
  it("formats durations without 60-second minutes", async () => {
    const { formatDuration } = await import("../src/lib/ui.ts");
    expect(formatDuration(119_600)).toBe("2m 00s");
    expect(formatDuration(59_600)).toBe("1m 00s");
    expect(formatDuration(9_940)).toBe("9.9s");
  });

  it("sorts pre-releases by number", async () => {
    const { compareVersions, assetName } = await import("../src/commands/update.ts");
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.9")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(assetName("linux", "x64", true)).toBe("opensume-linux-x64-musl");
    expect(assetName("darwin", "arm64", true)).toBe("opensume-darwin-arm64");
  });

  it("refuses unknown commands even with --help, and reads dash-led text as text", async () => {
    expect((await runCli(["nonexistent", "--help"])).code).toBe(2);
    const { parse } = await import("../src/lib/args.ts");
    expect(parse(root, ["run", "m", "-a dog"]).args).toEqual(["m", "-a dog"]);
  });

  it("answers --json for command groups and completion", async () => {
    expect((await runCli(["jobs", "--json"])).json()).toMatchObject({ command: "opensume jobs" });
    expect((await runCli(["completion", "bash", "--json"])).json()).toMatchObject({ shell: "bash" });
  });
});

describe("color", () => {
  it("never writes escape codes into piped stdout", async () => {
    const { main } = await import("../src/cli.ts");
    const { Capture } = await import("./helpers/run-cli.ts");
    const stdout = new Capture(false);
    const stderr = new Capture(true);
    await main({ argv: ["--help"], env: {}, stdout, stderr });
    expect(stdout.text).not.toContain("\u001b[");
    const tty = new Capture(true);
    await main({ argv: ["--help"], env: {}, stdout: tty, stderr: new Capture(true) });
    expect(tty.text).toContain("\u001b[1m");
  });
});
