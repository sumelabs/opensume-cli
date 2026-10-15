import { describe, expect, it } from "vitest";
import { type CommandSpec, closest, levenshtein, parse } from "../src/lib/args.ts";
import { UsageError } from "../src/lib/errors.ts";

const run = async () => undefined;
const root: CommandSpec = {
  name: "opensume",
  summary: "test",
  flags: [
    { name: "json", type: "boolean", description: "" },
    { name: "help", short: "h", type: "boolean", description: "" },
  ],
  commands: [
    {
      name: "run",
      summary: "",
      args: [
        { name: "model", required: true, description: "" },
        { name: "prompt", description: "" },
      ],
      flags: [
        { name: "output", short: "o", type: "string", description: "" },
        { name: "duration", short: "d", type: "number", description: "" },
        { name: "image", type: "string", multiple: true, description: "" },
        { name: "generate-audio", type: "boolean", description: "" },
        { name: "kind", type: "string", choices: ["image", "video"], description: "" },
      ],
      run,
    },
    {
      name: "jobs",
      aliases: ["job"],
      summary: "",
      commands: [{ name: "wait", summary: "", args: [{ name: "id", required: true, description: "" }], run }],
    },
  ],
};

describe("parse", () => {
  it("walks subcommands and collects arguments", () => {
    const parsed = parse(root, ["run", "gpt-image-2", "a cup", "-o", "out.png"]);
    expect(parsed.path).toEqual(["run"]);
    expect(parsed.args).toEqual(["gpt-image-2", "a cup"]);
    expect(parsed.flags.output).toBe("out.png");
  });

  it("accepts global flags anywhere and aliases for commands", () => {
    const parsed = parse(root, ["--json", "job", "wait", "job_1"]);
    expect(parsed.path).toEqual(["jobs", "wait"]);
    expect(parsed.flags.json).toBe(true);
    expect(parse(root, ["jobs", "wait", "job_1", "--json"]).flags.json).toBe(true);
  });

  it("reads --flag=value, numbers, repeats and negations", () => {
    const parsed = parse(root, [
      "run",
      "m",
      "--duration=4",
      "--image",
      "a.png",
      "--image=b.png",
      "--no-generate-audio",
    ]);
    expect(parsed.flags.duration).toBe(4);
    expect(parsed.flags.image).toEqual(["a.png", "b.png"]);
    expect(parsed.flags["generate-audio"]).toBe(false);
  });

  it("takes a value that starts with a dash when the flag needs one", () => {
    expect(parse(root, ["run", "m", "-o", "-weird-name.png"]).flags.output).toBe("-weird-name.png");
  });

  it("treats everything after -- as arguments", () => {
    expect(parse(root, ["run", "m", "--", "--not-a-flag"]).args).toEqual(["m", "--not-a-flag"]);
  });

  it("explains mistakes, with suggestions", () => {
    expect(() => parse(root, ["run", "m", "--outptu", "x"])).toThrow(/Unknown flag --outptu/u);
    try {
      parse(root, ["run", "m", "--outptu", "x"]);
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).hint).toBe("Did you mean --output?");
      expect((error as UsageError).exitCode).toBe(2);
    }
    expect(() => parse(root, ["run"])).toThrow(/Missing <model>/u);
    expect(() => parse(root, ["run", "m", "p", "extra"])).toThrow(/Unexpected argument "extra"/u);
    expect(() => parse(root, ["run", "m", "--duration", "four"])).toThrow(/must be a number/u);
    expect(() => parse(root, ["run", "m", "--kind", "audio"])).toThrow(/must be one of: image, video/u);
    expect(() => parse(root, ["run", "m", "-o"])).toThrow(/--output needs a value/u);
    expect(() => parse(root, ["run", "m", "-o", "--json"])).toThrow(/--output needs a value/u);
    expect(() => parse(root, ["jobs", "wiat"])).toThrow(/Unknown command "jobs wiat"/u);
  });

  it("skips argument checks when help is asked for", () => {
    expect(parse(root, ["run", "--help"]).flags.help).toBe(true);
  });
});

describe("suggestions", () => {
  it("measures edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("only suggests close matches", () => {
    expect(closest("gpt-image2", ["gpt-image-2", "seedance-2"])).toBe("gpt-image-2");
    expect(closest("zzzzzz", ["gpt-image-2", "seedance-2"])).toBeUndefined();
  });
});
