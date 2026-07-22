import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const forkDir = join(root, "baseline", "fork");
const routesDir = join(root, "baseline", "routes");
const abiDir = join(root, "baseline", "abi");

// Pinned to match zFi-main/foundry.toml so captures are reproducible.
const PINNED_BLOCK = 24_880_000;
const DEFAULT_RPC = "https://eth.drpc.org";

function resolveForge() {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;
  const which = spawnSync("command", ["-v", "forge"], { shell: true, encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = join(process.env.HOME || "", ".foundry/bin/forge");
  return existsSync(fallback) ? fallback : null;
}

function parseLines(stdout) {
  let meta = null;
  const captures = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("ROUTE_META ")) {
      meta = JSON.parse(line.slice("ROUTE_META ".length));
    } else if (line.startsWith("ROUTE_JSON ")) {
      captures.push(JSON.parse(line.slice("ROUTE_JSON ".length)));
    }
  }
  return { meta, captures };
}

function main() {
  const forge = resolveForge();
  if (!forge) {
    console.error("forge not found. Install Foundry from https://getfoundry.sh/");
    process.exit(1);
  }
  const rpc = process.env.ETH_RPC_URL || DEFAULT_RPC;

  console.log(`capturing baseline at block ${PINNED_BLOCK} via ${rpc} ...`);
  const result = spawnSync(
    forge,
    [
      "script",
      "src/CaptureBaseline.s.sol:CaptureBaseline",
      "--rpc-url",
      rpc,
    ],
    { cwd: forkDir, encoding: "utf8", env: { ...process.env, ETH_RPC_URL: rpc }, maxBuffer: 64 * 1024 * 1024 },
  );

  const stdout = result.stdout || "";
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    process.stderr.write(stdout);
    console.error(`forge script failed (exit ${result.status})`);
    process.exit(1);
  }

  const { meta, captures } = parseLines(stdout);
  if (!meta || captures.length === 0) {
    console.error("no ROUTE_META/ROUTE_JSON lines captured");
    process.exit(1);
  }
  if (meta.block !== PINNED_BLOCK) {
    console.error(`captured block ${meta.block} != pinned ${PINNED_BLOCK}`);
    process.exit(1);
  }

  // Normalize the revert selector from the raw 4-byte return data.
  for (const cap of captures) {
    if (cap.kind === "revert") {
      cap.revertSelector = cap.returnData && cap.returnData.length >= 10 ? cap.returnData.slice(0, 10) : "0x";
    }
  }

  const quoterAbi = JSON.parse(readFileSync(join(abiDir, "zQuoter.json"), "utf8"));
  const errorSelectors = new Set(quoterAbi.abi.errors.map((e) => e.selector));

  const doc = {
    schema: "setwise-router/route-execution@1",
    description:
      "Representative zQuoter return values, gas usage, and revert selectors " +
      "captured on a mainnet fork at the pinned block, plus end-to-end zRouter " +
      "executions. Reproduce with scripts/capture-execution-fixtures.mjs " +
      "(requires an archive Ethereum RPC). Gas is EVM execution gas measured via " +
      "gasleft() and excludes the 21,000 intrinsic transaction cost and calldata cost.",
    upstream: { commit: JSON.parse(readFileSync(join(abiDir, "compatibility-matrix.json"), "utf8")).upstream.commit },
    capture: {
      rpc,
      block: meta.block,
      router: meta.router,
      // The quoter is deployed fresh inside the harness, so its address is
      // ephemeral and recorded only for traceability (not asserted by tests).
      quoter: meta.quoter,
    },
    captures,
  };

  // Sanity: revert captures must hit known zQuoter error selectors.
  for (const cap of captures) {
    if (cap.kind === "revert" && cap.revertSelector !== "0x" && !errorSelectors.has(cap.revertSelector)) {
      console.error(`${cap.id}: revert selector ${cap.revertSelector} not in zQuoter ABI errors`);
      process.exit(1);
    }
  }

  mkdirSync(routesDir, { recursive: true });
  writeFileSync(join(routesDir, "execution.json"), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote baseline/routes/execution.json (${captures.length} captures)`);
}

main();
