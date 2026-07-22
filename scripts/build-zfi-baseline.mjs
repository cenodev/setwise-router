import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const zfi = join(root, "zFi-main");

function resolveForge() {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;

  const which = spawnSync("command", ["-v", "forge"], {
    shell: true,
    encoding: "utf8",
  });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();

  const fallback = join(process.env.HOME || "", ".foundry/bin/forge");
  try {
    accessSync(fallback, constants.X_OK);
    return fallback;
  } catch {
    return null;
  }
}

const forge = resolveForge();
if (!forge) {
  console.error("forge not found. Install Foundry from https://getfoundry.sh/");
  process.exit(1);
}

const result = spawnSync(forge, ["build"], {
  cwd: zfi,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
