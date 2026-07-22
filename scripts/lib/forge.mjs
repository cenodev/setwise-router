import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function resolveForge() {
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

export function runForge(forge, args, { cwd, env = process.env, stdio = "inherit" } = {}) {
  const result = spawnSync(forge, args, {
    cwd,
    env,
    stdio,
    encoding: stdio === "pipe" ? "utf8" : undefined,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

/** Offline Foundry config: same compiler settings as zFi-main, no eth_rpc_url. */
export function withOfflineFoundryConfig(zfiRoot, fn) {
  const dir = mkdtempSync(join(tmpdir(), "setwise-router-forge-"));
  const configPath = join(dir, "foundry.toml");
  writeFileSync(
    configPath,
    `[profile.default]
solc = "0.8.34"
via_ir = true
optimizer = true
optimizer_runs = 9_999_999

[profile.zquoter]
src = "src"
test = "test"
via_ir = true
optimizer = true
optimizer_runs = 20

[profile.zquoter.optimizer_details]
yul = false
`,
  );

  try {
    return fn(configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const EIP170_MAX = 24_576;

export function deployedBytecodeSize(artifact) {
  const object = artifact?.deployedBytecode?.object ?? "0x";
  return Math.max(0, (object.length - 2) / 2);
}
