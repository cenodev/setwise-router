/**
 * Shared constants for deployment manifests and on-chain verification.
 */

import { ADDRESS_RE } from "../config/schema.mjs";

export { ADDRESS_RE };

/** Current deployment manifest schema version. */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * EIP-1967 implementation slot:
 * `bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)`
 */
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d938fcb";

/** `proxiableUUID()` — UUPS implementations expose this selector. */
export const UUPS_PROXIABLE_UUID_SELECTOR = "0x52d1902d";

/** `implementation()` on transparent/UUPS admin interfaces (optional signal). */
export const IMPLEMENTATION_SELECTOR = "0x5c60da1b";

/**
 * Setwise-owned contract roles tracked in deployment manifests.
 * UI labels use "Set"; internal keys keep pool/poolId terminology.
 */
export const MANIFEST_CONTRACT_ROLES = Object.freeze({
  setwiseRouter: {
    kind: "direct",
    displayName: "Set Router",
    configPath: ["router"],
  },
  setwiseQuoter: {
    kind: "direct",
    displayName: "Set Quoter",
    configPath: ["quoter"],
  },
  setwisePoolRegistry: {
    kind: "uups-proxy",
    displayName: "Set pool registry",
    configPath: ["venues", "setwise", "poolRegistry"],
  },
  setwiseTokenHub: {
    kind: "direct",
    displayName: "Set token hub",
    configPath: ["venues", "setwise", "tokenHub"],
  },
});

export const MANIFEST_CONTRACT_KINDS = Object.freeze(["direct", "uups-proxy", "implementation"]);

export const MANIFEST_STATUSES = Object.freeze(["pending", "deployed"]);
