import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  KNOWN_VENUES,
  isAddress,
  validateChainConfig,
  validateRegistry,
} from "../config/schema.mjs";
import {
  ConfigValidationError,
  UnsupportedChainError,
  loadRegistry,
  supportedChainIds,
  isSupportedChain,
  getChainConfig,
  getAllChains,
} from "../config/registry.mjs";
import {
  VENUE_DISPLAY_NAMES,
  generateAll,
  generateAppConfig,
  generateDeployInputs,
  generateServiceConfig,
} from "../config/generate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chains = loadRegistry();

const SUPPORTED = [1, 56, 4663, 8453];
const VERIFIED = [1, 56, 8453];

function baseConfig() {
  return structuredClone(
    JSON.parse(readFileSync(join(root, "config/chains/1.json"), "utf8")),
  );
}

function writeChainDir(configs) {
  const dir = mkdtempSync(join(tmpdir(), "sw-chains-"));
  for (const [id, config] of Object.entries(configs)) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(config));
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Acceptance: all four chains validate against the schema
// ---------------------------------------------------------------------------

test("all four supported chains load and validate", () => {
  assert.deepEqual(supportedChainIds(), SUPPORTED);
  for (const chainId of SUPPORTED) {
    const config = getChainConfig(chainId);
    assert.equal(config.chainId, chainId);
    const result = validateChainConfig(config, chainId);
    assert.deepEqual(result.errors, [], `chain ${chainId} should validate`);
  }
});

test("registry exposes exactly the four target chains", () => {
  assert.equal(getAllChains().size, SUPPORTED.length);
  for (const chainId of SUPPORTED) assert.ok(isSupportedChain(chainId));
});

// ---------------------------------------------------------------------------
// Acceptance: unsupported protocol capabilities are explicit
// ---------------------------------------------------------------------------

test("every chain declares every known venue explicitly", () => {
  for (const chainId of SUPPORTED) {
    const config = getChainConfig(chainId);
    for (const venue of KNOWN_VENUES) {
      assert.ok(venue in config.venues, `chain ${chainId} missing venue ${venue}`);
      assert.equal(
        typeof config.venues[venue].enabled,
        "boolean",
        `chain ${chainId} venue ${venue} must have a boolean enabled flag`,
      );
    }
  }
});

test("every enabled direct AMM has complete chain-specific adapter configuration", () => {
  for (const chainId of SUPPORTED) {
    const { venues } = getChainConfig(chainId);
    for (const venue of ["uniswapV2", "sushiswap", "pancakeSwap"]) {
      if (!venues[venue].enabled) continue;
      assert.ok(isAddress(venues[venue].factory), `${chainId}:${venue} factory`);
      assert.match(venues[venue].initCodeHash, /^0x[0-9a-fA-F]{64}$/);
      assert.ok(venues[venue].feeBps > 0, `${chainId}:${venue} feeBps`);
    }
    if (venues.uniswapV3.enabled) {
      assert.ok(isAddress(venues.uniswapV3.factory), `${chainId}:uniswapV3 factory`);
      assert.match(venues.uniswapV3.initCodeHash, /^0x[0-9a-fA-F]{64}$/);
      assert.deepEqual(venues.uniswapV3.fees, [100, 500, 3000, 10000]);
    }
    if (venues.uniswapV4.enabled) {
      assert.ok(isAddress(venues.uniswapV4.poolManager), `${chainId}:uniswapV4 manager`);
      assert.equal(venues.uniswapV4.hookPolicy, "hookless");
    }
  }
});

test("Robinhood Chain is scaffolded with every venue explicitly disabled", () => {
  const config = getChainConfig(4663);
  assert.equal(config.addressesVerified, false);
  for (const venue of KNOWN_VENUES) {
    assert.equal(config.venues[venue].enabled, false, `${venue} must be disabled`);
  }
  assert.equal(config.wrappedNative.address, null);
  assert.equal(config.multicall3, null);
  assert.equal(config.router, null);
  assert.equal(config.quoter, null);
});

test("verified chains carry non-zero core addresses", () => {
  for (const chainId of VERIFIED) {
    const config = getChainConfig(chainId);
    assert.equal(config.addressesVerified, true);
    assert.ok(isAddress(config.wrappedNative.address), `chain ${chainId} wrappedNative`);
    assert.ok(isAddress(config.multicall3), `chain ${chainId} multicall3`);
  }
});

test("no committed config uses the zero address", () => {
  const zero = "0x0000000000000000000000000000000000000000";
  const scan = (value, path) => {
    if (typeof value === "string") {
      assert.notEqual(value.toLowerCase(), zero, `zero address at ${path}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => scan(v, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scan(v, `${path}.${k}`);
    }
  };
  for (const chainId of SUPPORTED) scan(getChainConfig(chainId), `chain ${chainId}`);
});

// ---------------------------------------------------------------------------
// Acceptance: services cannot silently fall back to Ethereum configuration
// ---------------------------------------------------------------------------

test("getChainConfig throws for unsupported chains instead of falling back", () => {
  for (const bad of [999, 0, 137, NaN, undefined, "ethereum"]) {
    assert.throws(
      () => getChainConfig(bad),
      UnsupportedChainError,
      `expected throw for ${String(bad)}`,
    );
  }
});

test("UnsupportedChainError lists the supported chains", () => {
  try {
    getChainConfig(42);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof UnsupportedChainError);
    assert.deepEqual(err.supported, SUPPORTED);
    assert.match(err.message, /no implicit fallback/i);
  }
});

test("isSupportedChain rejects unknown chains", () => {
  assert.equal(isSupportedChain(1), true);
  assert.equal(isSupportedChain(137), false);
  assert.equal(isSupportedChain("nope"), false);
});

// ---------------------------------------------------------------------------
// Schema rejects malformed single-chain configs
// ---------------------------------------------------------------------------

test("rejects a zero wrappedNative address", () => {
  const config = baseConfig();
  config.wrappedNative.address = "0x0000000000000000000000000000000000000000";
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /wrappedNative/.test(e)));
});

test("rejects a malformed address", () => {
  const config = baseConfig();
  config.multicall3 = "0x1234";
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /multicall3/.test(e)));
});

test("rejects a chainId that does not match its file name", () => {
  const config = baseConfig();
  const result = validateChainConfig(config, 56);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /does not match file name/.test(e)));
});

test("rejects an undeclared venue (capabilities must be explicit)", () => {
  const config = baseConfig();
  delete config.venues.curve;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /venues\.curve/.test(e)));
});

test("rejects an unknown venue key", () => {
  const config = baseConfig();
  config.venues.mysteryDex = { enabled: true };
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unknown venue/.test(e)));
});

test("rejects an enabled V2 adapter without immutable derivation and fee inputs", () => {
  const config = baseConfig();
  delete config.venues.uniswapV2.initCodeHash;
  delete config.venues.uniswapV2.feeBps;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /uniswapV2.*initCodeHash/.test(e)));
  assert.ok(result.errors.some((e) => /uniswapV2.*feeBps/.test(e)));
});

test("rejects missing, duplicate, and invalid V3 fee configuration", () => {
  const config = baseConfig();
  config.venues.uniswapV3.fees = [500, 500, 0];
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /duplicate fee 500/.test(e)));
  assert.ok(result.errors.some((e) => /uint24 values greater than zero/.test(e)));
});

test("rejects an enabled V4 adapter without an explicit supported hook policy", () => {
  const config = baseConfig();
  config.venues.uniswapV4.hookPolicy = "any-hook";
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /hookPolicy/.test(e)));
});

test("rejects a verified chain missing its wrappedNative address", () => {
  const config = baseConfig();
  config.wrappedNative.address = null;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /addressesVerified/.test(e)));
});

test("rejects an RPC role that embeds a URL instead of an env-var name", () => {
  const config = baseConfig();
  config.rpc.primaryEnv = "https://user:pass@rpc.example.com";
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /env-var name/.test(e)));
});

test("rejects duplicate addresses across singleton roles within a chain", () => {
  const config = baseConfig();
  config.router = config.multicall3;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /used for both/.test(e)));
});

// ---------------------------------------------------------------------------
// Registry-level rejection: duplicate ids, duplicate keys, cross-chain reuse
// ---------------------------------------------------------------------------

test("validateRegistry rejects cross-chain reuse of a chain-unique address", () => {
  const eth = getChainConfig(1);
  const base = getChainConfig(8453);
  const tampered = structuredClone(base);
  tampered.wrappedNative.address = eth.wrappedNative.address;
  const result = validateRegistry(new Map([[1, eth], [8453, tampered]]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /reused across/.test(e)));
});

test("validateRegistry allows the canonical cross-chain Multicall3 address", () => {
  const result = validateRegistry(chains);
  assert.deepEqual(result.errors, []);
});

test("validateRegistry rejects duplicate chain keys", () => {
  const eth = getChainConfig(1);
  const dup = structuredClone(eth);
  dup.chainId = 999;
  const result = validateRegistry(new Map([[1, eth], [999, dup]]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /duplicate chain keys/.test(e)));
});

test("loadRegistry throws ConfigValidationError on duplicate chain ids", () => {
  const config = baseConfig();
  const dir = writeChainDir({ 1: config, 100: config });
  assert.throws(() => loadRegistry(dir), ConfigValidationError);
});

test("loadRegistry throws on an empty chain directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-empty-"));
  assert.throws(() => loadRegistry(dir), ConfigValidationError);
});

// ---------------------------------------------------------------------------
// Generated typed configuration
// ---------------------------------------------------------------------------

test("service config exposes RPC env-var names, never secret values", () => {
  const service = generateServiceConfig(chains);
  for (const chainId of SUPPORTED) {
    const entry = service.chains[chainId];
    assert.match(entry.rpc.primaryEnv, /^[A-Z0-9_]+$/, "primaryEnv is an env name");
    assert.ok(!/^https?:\/\//.test(entry.rpc.primaryEnv), "no URL in primaryEnv");
    assert.equal(typeof entry.multicall3 === "string" || entry.multicall3 === null, true);
  }
});

test("service config only lists enabled venues", () => {
  const service = generateServiceConfig(chains);
  assert.ok("uniswapV3" in service.chains[1].venues);
  assert.ok(!("pancakeSwap" in service.chains[1].venues));
  assert.ok("pancakeSwap" in service.chains[56].venues);
  assert.equal(Object.keys(service.chains[4663].venues).length, 0);
});

test("app config uses 'Set' for the Setwise venue but keeps internal keys", () => {
  const app = generateAppConfig(chains);
  assert.equal(VENUE_DISPLAY_NAMES.setwise, "Set");
  for (const chainId of SUPPORTED) {
    const venues = app.chains[chainId].venues;
    assert.ok("setwise" in venues, "internal key preserved");
    assert.equal(venues.setwise.displayName, "Set");
  }
});

test("deploy inputs null out unverified Robinhood addresses", () => {
  const deploy = generateDeployInputs(chains);
  const rh = deploy.chains[4663];
  assert.equal(rh.addressesVerified, false);
  assert.equal(rh.wrappedNative, null);
  assert.equal(rh.multicall3, null);
  assert.equal(rh.setwise.poolRegistry, null);
  assert.deepEqual(rh.venues, {});
});

test("deploy inputs surface verified core addresses", () => {
  const deploy = generateDeployInputs(chains);
  assert.ok(isAddress(deploy.chains[1].wrappedNative));
  assert.ok(isAddress(deploy.chains[1].multicall3));
  assert.ok(isAddress(deploy.chains[1].venues.uniswapV3.factory));
  assert.match(deploy.chains[1].venues.uniswapV3.initCodeHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(deploy.chains[1].venues.uniswapV3.fees, [100, 500, 3000, 10000]);
  assert.equal(deploy.chains[1].venues.uniswapV4.hookPolicy, "hookless");
  assert.equal(deploy.chains[56].venues.pancakeSwap.feeBps, 25);
});

test("generation is deterministic", () => {
  assert.deepEqual(generateAll(chains), generateAll(chains));
});

test("generated config is git-ignored", () => {
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /config\/generated\//);
});
