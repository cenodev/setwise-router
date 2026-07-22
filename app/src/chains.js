import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateAppConfig } from "../../config/generate.mjs";
import {
  getAllChains,
  getChainConfig,
  isSupportedChain,
  supportedChainIds,
} from "../../config/index.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Public RPC endpoints used only for wallet_addEthereumChain when registry omits publicUrl. */
const WALLET_RPC_FALLBACKS = Object.freeze({
  4663: "https://rpc.mainnet.chain.robinhood.com",
});

/** @typedef {{ chainId: number, account: string|null, request: Function, switchChain: Function, addChain: Function }} WalletClient */

/**
 * Load generated frontend config when present; otherwise derive from the registry.
 *
 * @returns {import("../../config/generate.mjs").ReturnType<typeof import("../../config/generate.mjs").generateAppConfig>}
 */
export function loadAppConfig() {
  const generated = join(appRoot, "..", "config", "generated", "app-config.json");
  if (existsSync(generated)) {
    return JSON.parse(readFileSync(generated, "utf8"));
  }
  return generateAppConfig(getAllChains());
}

/**
 * @param {number} chainId
 * @returns {{ chainId: number, key: string, displayName: string }}
 */
export function getChainOption(chainId) {
  const config = getChainConfig(chainId);
  return {
    chainId: config.chainId,
    key: config.key,
    displayName: config.displayName,
  };
}

/** @returns {ReturnType<typeof getChainOption>[]} */
export function listSupportedChains() {
  return supportedChainIds().map((chainId) => getChainOption(chainId));
}

/**
 * Build EIP-3085 `wallet_addEthereumChain` parameters for a supported chain.
 *
 * @param {number} chainId
 */
export function buildAddChainParams(chainId) {
  const config = getChainConfig(chainId);
  const rpcUrl = config.rpc.publicUrl ?? WALLET_RPC_FALLBACKS[chainId];
  if (!rpcUrl) {
    throw new Error(
      `chain ${chainId} has no public RPC URL; configure ${config.rpc.primaryEnv} for wallet switching`,
    );
  }

  const wrapped = config.wrappedNative.address;
  const params = {
    chainId: `0x${chainId.toString(16)}`,
    chainName: config.displayName,
    nativeCurrency: {
      name: config.nativeToken.name,
      symbol: config.nativeToken.symbol,
      decimals: config.nativeToken.decimals,
    },
    rpcUrls: [rpcUrl],
    blockExplorerUrls: config.explorer.baseUrl ? [config.explorer.baseUrl] : [],
  };

  if (wrapped) {
    params.iconUrls = [];
  }

  return params;
}

/**
 * @param {number|null|undefined} walletChainId
 * @param {number|null|undefined} selectedChainId
 */
export function resolveNetworkState(walletChainId, selectedChainId = walletChainId) {
  if (walletChainId == null) {
    return {
      status: "disconnected",
      walletChainId: null,
      selectedChainId: selectedChainId ?? null,
      supported: false,
      recoverable: true,
      message: "Connect a wallet to choose a network.",
    };
  }

  if (!isSupportedChain(walletChainId)) {
    return {
      status: "unsupported",
      walletChainId,
      selectedChainId: selectedChainId ?? walletChainId,
      supported: false,
      recoverable: true,
      message: `Unsupported network (chain ${walletChainId}). Switch to Ethereum, BSC, Base, or Robinhood Chain.`,
    };
  }

  if (selectedChainId != null && selectedChainId !== walletChainId) {
    return {
      status: "wrong-chain",
      walletChainId,
      selectedChainId,
      supported: true,
      recoverable: true,
      message: `Wallet is on ${getChainOption(walletChainId).displayName}, but ${getChainOption(selectedChainId).displayName} is selected.`,
    };
  }

  return {
    status: "ready",
    walletChainId,
    selectedChainId: selectedChainId ?? walletChainId,
    supported: true,
    recoverable: false,
    message: null,
  };
}

/**
 * Request a wallet network switch with recoverable failure handling.
 *
 * @param {WalletClient} wallet
 * @param {number} chainId
 */
export async function requestChainSwitch(wallet, chainId) {
  if (!isSupportedChain(chainId)) {
    return {
      ok: false,
      recoverable: false,
      code: "UNSUPPORTED_CHAIN",
      message: `Chain ${chainId} is not supported by Setwise Router.`,
    };
  }

  const hexChainId = `0x${chainId.toString(16)}`;

  try {
    await wallet.switchChain({ chainId: hexChainId });
    return { ok: true, chainId, added: false };
  } catch (error) {
    const code = error?.code ?? "SWITCH_FAILED";

    if (code === 4902 || /unrecognized chain/i.test(String(error?.message))) {
      try {
        await wallet.addChain(buildAddChainParams(chainId));
        await wallet.switchChain({ chainId: hexChainId });
        return { ok: true, chainId, added: true };
      } catch (addError) {
        return {
          ok: false,
          recoverable: true,
          code: addError?.code ?? "ADD_CHAIN_FAILED",
          message:
            addError?.message ??
            "Failed to add the network to your wallet. Try again or add it manually.",
        };
      }
    }

    if (code === 4001) {
      return {
        ok: false,
        recoverable: true,
        code: "USER_REJECTED",
        message: "Network switch was cancelled.",
      };
    }

    return {
      ok: false,
      recoverable: true,
      code,
      message: error?.message ?? "Network switch failed.",
    };
  }
}
