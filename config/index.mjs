/**
 * Public entry point for the typed multi-chain configuration registry.
 *
 * Usage:
 *   import { getChainConfig, supportedChainIds } from "../config/index.mjs";
 *   const chain = getChainConfig(8453); // throws for unsupported chains
 */

export {
  ConfigValidationError,
  UnsupportedChainError,
  loadRegistry,
  registry,
  supportedChainIds,
  isSupportedChain,
  getChainConfig,
  getAllChains,
} from "./registry.mjs";

export {
  KNOWN_VENUES,
  isAddress,
  isBytes32,
  validateChainConfig,
  validateRegistry,
} from "./schema.mjs";

export {
  VENUE_DISPLAY_NAMES,
  generateServiceConfig,
  generateAppConfig,
  generateDeployInputs,
  generateAll,
} from "./generate.mjs";

export {
  NATIVE_TOKEN_SENTINEL,
  isNativeAsset,
  getNativeConfig,
  requireWrappedNative,
  resolveNativeAsset,
} from "./native.mjs";
