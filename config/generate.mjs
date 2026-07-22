/**
 * Generate typed service, frontend, and contract-deployment configuration from
 * the canonical chain registry. One source of truth, three consumers.
 *
 * Outputs are deterministic (no timestamps) so diffs stay reviewable. Secrets
 * are never emitted: only RPC env-var *names* are included, never their values.
 *
 * Terminology: user-facing (app) labels use "Set" for Setwise liquidity, while
 * internal identifiers keep `setwise` / `poolRegistry` / `tokenHub` / `poolId`.
 */

import { KNOWN_VENUES } from "./schema.mjs";

/** UI-facing venue labels. Internal keys remain unchanged. */
export const VENUE_DISPLAY_NAMES = Object.freeze({
  uniswapV2: "Uniswap V2",
  uniswapV3: "Uniswap V3",
  uniswapV4: "Uniswap V4",
  sushiswap: "SushiSwap",
  pancakeSwap: "PancakeSwap",
  curve: "Curve",
  lido: "Lido",
  zamm: "zAMM",
  setwise: "Set",
});

function enabledVenues(config) {
  const out = {};
  for (const venue of KNOWN_VENUES) {
    const entry = config.venues[venue];
    if (entry?.enabled) out[venue] = entry;
  }
  return out;
}

function enabledAggregators(config) {
  const out = {};
  for (const [name, entry] of Object.entries(config.aggregators ?? {})) {
    if (entry?.enabled) out[name] = true;
  }
  return out;
}

/**
 * Configuration consumed by the quote service. Includes RPC env-var names,
 * infrastructure addresses, and enabled venues/aggregators per chain.
 *
 * @param {Map<number, import("./schema.mjs").ChainConfig>} chains
 */
export function generateServiceConfig(chains) {
  const out = { chains: {} };
  for (const [chainId, config] of chains) {
    out.chains[chainId] = {
      chainId,
      key: config.key,
      rpc: {
        publicUrl: config.rpc.publicUrl ?? null,
        primaryEnv: config.rpc.primaryEnv,
        archiveEnv: config.rpc.archiveEnv ?? null,
      },
      nativeToken: config.nativeToken,
      wrappedNative: config.wrappedNative,
      multicall3: config.multicall3,
      permit2: config.permit2 ?? null,
      router: config.router,
      quoter: config.quoter,
      explorer: config.explorer,
      venues: enabledVenues(config),
      aggregators: enabledAggregators(config),
      addressesVerified: config.addressesVerified,
    };
  }
  return out;
}

/**
 * Configuration consumed by the frontend. Uses "Set" for the Setwise venue
 * label; internal keys are preserved for API calls.
 *
 * @param {Map<number, import("./schema.mjs").ChainConfig>} chains
 */
export function generateAppConfig(chains) {
  const out = { chains: {} };
  for (const [chainId, config] of chains) {
    const venues = {};
    for (const venue of KNOWN_VENUES) {
      const entry = config.venues[venue];
      venues[venue] = {
        enabled: Boolean(entry?.enabled),
        displayName: VENUE_DISPLAY_NAMES[venue],
      };
    }
    out.chains[chainId] = {
      chainId,
      key: config.key,
      displayName: config.displayName,
      nativeToken: config.nativeToken,
      wrappedNative: config.wrappedNative,
      router: config.router,
      explorer: config.explorer,
      venues,
    };
  }
  return out;
}

/**
 * Contract deployment constructor inputs per chain. Only verified, non-null
 * addresses are surfaced as deploy inputs; unverified chains yield nulls so a
 * deployment cannot accidentally pick up another chain's addresses.
 *
 * @param {Map<number, import("./schema.mjs").ChainConfig>} chains
 */
export function generateDeployInputs(chains) {
  const out = { chains: {} };
  for (const [chainId, config] of chains) {
    const venues = {};
    for (const [venue, entry] of Object.entries(enabledVenues(config))) {
      venues[venue] = {
        factory: entry.factory ?? null,
        poolManager: entry.poolManager ?? null,
        initCodeHash: entry.initCodeHash ?? null,
      };
    }
    out.chains[chainId] = {
      chainId,
      addressesVerified: config.addressesVerified,
      wrappedNative: config.wrappedNative.address,
      multicall3: config.multicall3,
      permit2: config.permit2 ?? null,
      router: config.router,
      quoter: config.quoter,
      setwise: {
        poolRegistry: config.venues.setwise?.poolRegistry ?? null,
        tokenHub: config.venues.setwise?.tokenHub ?? null,
      },
      venues,
    };
  }
  return out;
}

/**
 * @param {Map<number, import("./schema.mjs").ChainConfig>} chains
 * @returns {{ service: object, app: object, deploy: object }}
 */
export function generateAll(chains) {
  return {
    service: generateServiceConfig(chains),
    app: generateAppConfig(chains),
    deploy: generateDeployInputs(chains),
  };
}
