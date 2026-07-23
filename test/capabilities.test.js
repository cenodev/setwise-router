import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_DISPLAY_NAMES,
  ETHEREUM_CHAIN_ID,
  KNOWN_CAPABILITIES,
  capabilityDefinition,
  isEthereumOnlyCapability,
} from "../config/capabilities.mjs";
import { KNOWN_VENUES, validateChainConfig } from "../config/schema.mjs";
import {
  getChainConfig,
  loadRegistry,
  supportedChainIds,
} from "../config/registry.mjs";
import {
  generateAll,
  generateAppConfig,
  generateDeployInputs,
  generateServiceConfig,
} from "../config/generate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chains = loadRegistry();

const SUPPORTED = [1, 56, 4663, 8453];
const NON_ETHEREUM = SUPPORTED.filter((id) => id !== ETHEREUM_CHAIN_ID);
const ETHEREUM_ONLY = KNOWN_CAPABILITIES.filter(isEthereumOnlyCapability);
// Issue #11 ZFi extensions: preserved on Ethereum, gated elsewhere. Newer
// capabilities (e.g. setwiseComposition, issue #17) ship disabled by design
// and are asserted separately.
const ZFI_EXTENSION_CAPABILITIES = ["lidoStaking", "nameNft", "zammLiquidity", "ownership"];

function baseConfig() {
  return structuredClone(
    JSON.parse(readFileSync(join(root, "config/chains/1.json"), "utf8")),
  );
}

// ---------------------------------------------------------------------------
// Acceptance: every chain-specific extension has an explicit capability entry
// ---------------------------------------------------------------------------

test("every chain declares every known capability explicitly", () => {
  for (const chainId of SUPPORTED) {
    const config = getChainConfig(chainId);
    for (const capability of KNOWN_CAPABILITIES) {
      assert.ok(
        capability in config.capabilities,
        `chain ${chainId} missing capability ${capability}`,
      );
      assert.equal(
        typeof config.capabilities[capability].enabled,
        "boolean",
        `chain ${chainId} capability ${capability} must have a boolean enabled flag`,
      );
    }
  }
});

test("capability definitions cover every known capability with a deployment requirement", () => {
  for (const capability of KNOWN_CAPABILITIES) {
    const definition = capabilityDefinition(capability);
    assert.equal(typeof definition.ethereumOnly, "boolean", `${capability}.ethereumOnly`);
    assert.ok(Array.isArray(definition.requiresVenues), `${capability}.requiresVenues`);
    assert.ok(definition.functions.length > 0, `${capability}.functions`);
    assert.ok(definition.decision.length > 0, `${capability}.decision`);
    // Required venues must be real venues so the requirement is enforceable.
    for (const venue of definition.requiresVenues) {
      assert.ok(KNOWN_VENUES.includes(venue), `${capability} requires unknown venue ${venue}`);
    }
  }
});

test("capability definitions align with the baseline Ethereum-only function set", () => {
  const matrix = JSON.parse(
    readFileSync(join(root, "baseline/abi/compatibility-matrix.json"), "utf8"),
  );
  const routerEthOnly = new Set(matrix.contracts.zRouter.scope.ethereumOnly);
  const quoterEthOnly = new Set(matrix.contracts.zQuoter.scope.ethereumOnly);
  const gated = new Set(
    KNOWN_CAPABILITIES.flatMap((c) => CAPABILITY_DEFINITIONS[c].functions),
  );
  // Every baseline Ethereum-only function is gated by a capability...
  for (const fn of [...routerEthOnly, ...quoterEthOnly]) {
    assert.ok(gated.has(fn), `baseline Ethereum-only function ${fn} is not capability-gated`);
  }
  // ...and every gated function appears in the baseline ABI.
  const abiFunctions = new Set([
    ...Object.keys(matrix.contracts.zRouter.scope.byScope).flatMap(
      (s) => matrix.contracts.zRouter.scope.byScope[s],
    ),
    ...Object.keys(matrix.contracts.zQuoter.scope.byScope).flatMap(
      (s) => matrix.contracts.zQuoter.scope.byScope[s],
    ),
  ]);
  for (const fn of gated) {
    assert.ok(abiFunctions.has(fn), `gated function ${fn} missing from baseline ABI`);
  }
});

// ---------------------------------------------------------------------------
// Acceptance: preserve enabled Ethereum behavior
// ---------------------------------------------------------------------------

test("Ethereum keeps every ZFi extension capability enabled", () => {
  const config = getChainConfig(ETHEREUM_CHAIN_ID);
  for (const capability of ZFI_EXTENSION_CAPABILITIES) {
    assert.equal(config.capabilities[capability].enabled, true, `${capability} on Ethereum`);
  }
  const result = validateChainConfig(config, ETHEREUM_CHAIN_ID);
  assert.deepEqual(result.errors, []);
});

test("non-swap extension decisions are encoded", () => {
  assert.equal(CAPABILITY_DEFINITIONS.nameNft.decision, "ethereum-only");
  assert.equal(CAPABILITY_DEFINITIONS.zammLiquidity.decision, "out-of-swap-scope");
  assert.equal(CAPABILITY_DEFINITIONS.ownership.decision, "retain");
  // Ownership is retained on every chain; the others stay Ethereum-only.
  assert.equal(CAPABILITY_DEFINITIONS.ownership.ethereumOnly, false);
  for (const capability of ["lidoStaking", "nameNft", "zammLiquidity"]) {
    assert.equal(CAPABILITY_DEFINITIONS[capability].ethereumOnly, true, capability);
  }
});

// ---------------------------------------------------------------------------
// Acceptance: no Ethereum address is reachable from another chain configuration
// ---------------------------------------------------------------------------

test("non-Ethereum chains disable every Ethereum-only capability", () => {
  for (const chainId of NON_ETHEREUM) {
    const config = getChainConfig(chainId);
    for (const capability of ETHEREUM_ONLY) {
      assert.equal(
        config.capabilities[capability].enabled,
        false,
        `chain ${chainId} must disable ${capability}`,
      );
    }
    // Ownership is retained everywhere.
    assert.equal(config.capabilities.ownership.enabled, true, `ownership on ${chainId}`);
  }
});

test("rejects enabling an Ethereum-only capability on a non-Ethereum chain", () => {
  for (const chainId of NON_ETHEREUM) {
    const config = structuredClone(getChainConfig(chainId));
    for (const capability of ETHEREUM_ONLY) {
      const tampered = structuredClone(config);
      tampered.capabilities[capability].enabled = true;
      // Satisfy the venue requirement so only the chain restriction is tested.
      for (const venue of CAPABILITY_DEFINITIONS[capability].requiresVenues) {
        tampered.venues[venue].enabled = true;
      }
      const result = validateChainConfig(tampered, chainId);
      assert.equal(result.valid, false, `${capability} should be rejected on ${chainId}`);
      assert.ok(
        result.errors.some((e) => new RegExp(`capabilities.${capability}.*Ethereum-only`).test(e)),
        `expected Ethereum-only error for ${capability} on ${chainId}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Acceptance: disabled features cannot be wired (revert before moving assets)
// ---------------------------------------------------------------------------

test("rejects enabling a capability whose required venue is disabled", () => {
  const config = baseConfig();
  config.venues.lido.enabled = false;
  config.capabilities.lidoStaking.enabled = true;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => /capabilities\.lidoStaking requires venues\.lido/.test(e)),
  );
});

test("rejects enabling zAMM liquidity without the zAMM venue", () => {
  const config = baseConfig();
  config.venues.zamm.enabled = false;
  config.capabilities.zammLiquidity.enabled = true;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => /capabilities\.zammLiquidity requires venues\.zamm/.test(e)),
  );
});

test("disabled capabilities surface no service wiring or deploy inputs", () => {
  const service = generateServiceConfig(chains);
  const deploy = generateDeployInputs(chains);
  for (const chainId of NON_ETHEREUM) {
    for (const capability of ETHEREUM_ONLY) {
      assert.ok(
        !(capability in service.chains[chainId].capabilities),
        `service config must omit ${capability} on chain ${chainId}`,
      );
      assert.ok(
        !(capability in deploy.chains[chainId].capabilities),
        `deploy inputs must omit ${capability} on chain ${chainId}`,
      );
    }
    // No gated function for a disabled capability is reachable.
    const surfaced = new Set(
      Object.values(service.chains[chainId].capabilities).flatMap((c) => c.functions),
    );
    for (const capability of ETHEREUM_ONLY) {
      for (const fn of CAPABILITY_DEFINITIONS[capability].functions) {
        assert.ok(!surfaced.has(fn), `${fn} must not be reachable on chain ${chainId}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Acceptance: mixed Set composite routes ship behind a disabled capability (#17)
// ---------------------------------------------------------------------------

test("setwiseComposition is disabled on every supported chain", () => {
  assert.equal(CAPABILITY_DEFINITIONS.setwiseComposition.decision, "disabled");
  assert.equal(CAPABILITY_DEFINITIONS.setwiseComposition.ethereumOnly, false);
  for (const chainId of SUPPORTED) {
    const config = getChainConfig(chainId);
    assert.equal(
      config.capabilities.setwiseComposition.enabled,
      false,
      `setwiseComposition on chain ${chainId}`,
    );
    const result = validateChainConfig(config, chainId);
    assert.deepEqual(result.errors, [], `chain ${chainId} stays valid`);
  }
});

test("disabled setwiseComposition surfaces no service wiring or deploy inputs", () => {
  const service = generateServiceConfig(chains);
  const deploy = generateDeployInputs(chains);
  const app = generateAppConfig(chains);
  for (const chainId of SUPPORTED) {
    assert.ok(
      !("setwiseComposition" in service.chains[chainId].capabilities),
      `service config must omit setwiseComposition on chain ${chainId}`,
    );
    assert.ok(
      !("setwiseComposition" in deploy.chains[chainId].capabilities),
      `deploy inputs must omit setwiseComposition on chain ${chainId}`,
    );
    // The app still sees the explicit flag with its Set-facing display name.
    const entry = app.chains[chainId].capabilities.setwiseComposition;
    assert.equal(entry.enabled, false, `app flag on chain ${chainId}`);
    assert.equal(entry.displayName, CAPABILITY_DISPLAY_NAMES.setwiseComposition);
    assert.match(entry.displayName, /\bSet\b/);
  }
});

test("rejects enabling setwiseComposition without the Set venue", () => {
  const config = baseConfig();
  config.capabilities.setwiseComposition.enabled = true;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) =>
      /capabilities\.setwiseComposition requires venues\.setwise/.test(e)
    ),
  );
});

// ---------------------------------------------------------------------------
// Schema rejects malformed capability declarations
// ---------------------------------------------------------------------------

test("rejects an undeclared capability (must be explicit)", () => {
  const config = baseConfig();
  delete config.capabilities.nameNft;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /capabilities\.nameNft/.test(e)));
});

test("rejects a missing capabilities object", () => {
  const config = baseConfig();
  delete config.capabilities;
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /capabilities must be an object/.test(e)));
});

test("rejects a non-boolean capability flag", () => {
  const config = baseConfig();
  config.capabilities.ownership.enabled = "yes";
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /capabilities\.ownership\.enabled/.test(e)));
});

test("rejects an unknown capability key", () => {
  const config = baseConfig();
  config.capabilities.mysteryFeature = { enabled: true };
  const result = validateChainConfig(config, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unknown capability/.test(e)));
});

// ---------------------------------------------------------------------------
// Generated configuration
// ---------------------------------------------------------------------------

test("app config exposes capability flags with display names and internal keys", () => {
  const app = generateAppConfig(chains);
  for (const chainId of SUPPORTED) {
    const capabilities = app.chains[chainId].capabilities;
    for (const capability of KNOWN_CAPABILITIES) {
      assert.ok(capability in capabilities, `app config missing ${capability}`);
      assert.equal(
        capabilities[capability].displayName,
        CAPABILITY_DISPLAY_NAMES[capability],
      );
    }
    assert.equal(capabilities.lidoStaking.enabled, chainId === ETHEREUM_CHAIN_ID);
  }
});

test("service config lists enabled capabilities with their gated functions", () => {
  const service = generateServiceConfig(chains);
  assert.deepEqual(
    service.chains[1].capabilities.lidoStaking.functions,
    CAPABILITY_DEFINITIONS.lidoStaking.functions,
  );
  assert.equal(Object.keys(service.chains[56].capabilities).length, 1);
  assert.ok("ownership" in service.chains[56].capabilities);
});

test("capability generation is deterministic", () => {
  assert.deepEqual(generateAll(chains), generateAll(chains));
});

test("capabilityDefinition throws for unknown capabilities", () => {
  assert.throws(() => capabilityDefinition("nope"), /unknown capability/);
});
