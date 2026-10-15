import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assetName, compareVersions, parseChecksums } from "../src/commands/update.ts";
import { VERSION } from "../src/version.ts";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("update helpers", () => {
  it("compares versions, pre-releases first", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  });

  it("reads sha256sum output", () => {
    const sums = parseChecksums(`${"a".repeat(64)}  opensume-linux-x64\n${"B".repeat(64)} *opensume-windows-x64.exe\n`);
    expect(sums.get("opensume-linux-x64")).toBe("a".repeat(64));
    expect(sums.get("opensume-windows-x64.exe")).toBe("b".repeat(64));
  });

  it("names release assets like install.sh does", () => {
    expect(assetName("darwin", "arm64")).toBe("opensume-darwin-arm64");
    expect(assetName("linux", "x64")).toBe("opensume-linux-x64");
    expect(assetName("win32", "x64")).toBe("opensume-windows-x64.exe");
    expect(() => assetName("freebsd", "x64")).toThrow(/No prebuilt binary/u);
  });
});
