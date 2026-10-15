#!/usr/bin/env node
// Compile standalone binaries with Bun, one per target, into dist/bin/.
//
//   node scripts/build-binaries.mjs              # every target
//   node scripts/build-binaries.mjs linux-x64    # one target
//
// Names match install.sh, install.ps1 and `opensume update`:
// opensume-<os>-<arch>[.exe].
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
const wanted = process.argv.slice(2);
const targets = wanted.length ? wanted : TARGETS;
for (const target of targets) {
  if (!TARGETS.includes(target)) {
    console.error(`Unknown target "${target}". Pick from: ${TARGETS.join(", ")}`);
    process.exit(2);
  }
}

const out = join("dist", "bin");
mkdirSync(out, { recursive: true });
const sums = [];
for (const target of targets) {
  const file = `opensume-${target}${target.startsWith("windows") ? ".exe" : ""}`;
  const result = spawnSync(
    "bun",
    ["build", "src/bin.ts", "--compile", "--minify", `--target=bun-${target}`, `--outfile=${join(out, file)}`],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  const hash = createHash("sha256")
    .update(readFileSync(join(out, file)))
    .digest("hex");
  sums.push(`${hash}  ${file}`);
}
writeFileSync(join(out, "checksums.txt"), `${sums.join("\n")}\n`);
console.log(`Built ${targets.length} binar${targets.length === 1 ? "y" : "ies"} in ${out}`);
