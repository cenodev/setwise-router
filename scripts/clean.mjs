import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  "node_modules",
  "contracts/out",
  "contracts/cache",
  "contracts/broadcast",
  "config/generated",
  "zFi-main/out",
  "zFi-main/cache",
];

for (const rel of targets) {
  const abs = join(root, rel);
  if (existsSync(abs)) {
    rmSync(abs, { recursive: true, force: true });
    console.log(`removed ${rel}`);
  }
}

console.log("clean complete");
