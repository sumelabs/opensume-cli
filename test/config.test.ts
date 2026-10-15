import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configDir,
  DEFAULT_BASE_URL,
  DEV_BASE_URL,
  maskKey,
  otherHostHint,
  readConfig,
  resolveSettings,
  writeConfig,
} from "../src/lib/config.ts";

const dir = () => mkdtempSync(join(tmpdir(), "opensume-config-"));

describe("resolveSettings", () => {
  it("prefers flags, then the environment, then the config file", () => {
    const configDirPath = dir();
    writeConfig(join(configDirPath, "config.json"), { api_key: "from-config", base_url: "https://config.example" });
    const env = { OPENSUME_CONFIG_DIR: configDirPath };

    expect(resolveSettings({}, env)).toMatchObject({
      apiKey: "from-config",
      apiKeySource: "config",
      baseUrl: "https://config.example",
      baseUrlSource: "config",
    });
    expect(
      resolveSettings({}, { ...env, SUME_API_KEY: "from-env", SUME_API_BASE_URL: "https://env.example" }),
    ).toMatchObject({
      apiKey: "from-env",
      apiKeySource: "env",
      baseUrl: "https://env.example",
      baseUrlSource: "env",
    });
    expect(
      resolveSettings({ apiKey: "from-flag", baseUrl: "https://flag.example" }, { ...env, SUME_API_KEY: "from-env" }),
    ).toMatchObject({
      apiKey: "from-flag",
      apiKeySource: "flag",
      baseUrl: "https://flag.example",
      baseUrlSource: "flag",
    });
  });

  it("defaults to Open production, not sume.com's API", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.open.sume.com");
  });

  it("names the other stack when a key is refused", () => {
    expect(otherHostHint(DEFAULT_BASE_URL)).toContain(`--base-url ${DEV_BASE_URL}`);
    expect(otherHostHint(DEV_BASE_URL)).toContain(`--base-url ${DEFAULT_BASE_URL}`);
    expect(otherHostHint("http://localhost:8787")).toContain(`--base-url ${DEFAULT_BASE_URL}`);
  });

  it("defaults to the default host with no key", () => {
    expect(resolveSettings({}, { OPENSUME_CONFIG_DIR: dir() })).toMatchObject({
      apiKey: undefined,
      baseUrl: DEFAULT_BASE_URL,
      baseUrlSource: "default",
    });
  });
});

describe("config file", () => {
  it("is written owner-only", () => {
    const file = join(dir(), "nested", "config.json");
    writeConfig(file, { api_key: "secret" });
    expect(readConfig(file)).toEqual({ api_key: "secret" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("explains a broken file instead of crashing", () => {
    const file = join(dir(), "config.json");
    writeFileSync(file, "{not json");
    expect(() => readConfig(file)).toThrow(/not valid JSON/u);
  });

  it("follows XDG_CONFIG_HOME and APPDATA", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "opensume"));
    expect(configDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toContain("opensume");
    expect(configDir({ OPENSUME_CONFIG_DIR: "/custom" }, "darwin")).toBe("/custom");
  });
});

describe("maskKey", () => {
  it("shows what the API keys page shows, never the whole key", () => {
    const key = `sume_live_Ab12_cd3${"x".repeat(30)}9QzK`;
    expect(maskKey(key)).toBe("sume_live_Ab12_cd3…9QzK");
    expect(maskKey("short")).toBe("…");
  });
});
