import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fix = process.argv.includes("--fix");

const dirs = [
  "scripts",
  "scripts/lib",
  "test",
  "config",
  "services/quote/src",
  "services/quote/test",
  "app/src",
  "app/scripts",
  "app/test",
];
let failed = false;

for (const dir of dirs) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  const files = readdirSync(abs).filter(
    (f) => f.endsWith(".js") || f.endsWith(".mjs"),
  );
  for (const file of files) {
    const filePath = join(abs, file);
    const result = spawnSync(process.execPath, ["--check", filePath], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      failed = true;
      console.error(`format/syntax issue: ${dir}/${file}`);
      if (result.stderr) process.stderr.write(result.stderr);
    } else {
      console.log(`ok ${dir}/${file}`);
    }
  }
}

if (fix) {
  console.log("\n--fix: no auto-formatter configured yet; syntax check only.");
}

if (failed) process.exit(1);
