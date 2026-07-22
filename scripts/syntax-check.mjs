import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  "scripts/build-zfi-baseline.mjs",
  "scripts/syntax-check.mjs",
  "test/provenance.test.js",
  "zFi-main/server/index.js",
  "zFi-main/server/quote.js",
  "zFi-main/server/pin.js",
  "zFi-main/dev_server.mjs",
];

let failed = false;
for (const rel of files) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    console.error(`missing: ${rel}`);
    failed = true;
    continue;
  }
  const result = spawnSync(process.execPath, ["--check", abs], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`syntax error: ${rel}`);
    if (result.stderr) process.stderr.write(result.stderr);
  } else {
    console.log(`ok ${rel}`);
  }
}

if (failed) process.exit(1);
