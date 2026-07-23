/**
 * Capability model for chain-specific ZFi extensions (issue #11).
 *
 * The immutable ZFi router/quoter ABI is identical on every chain (see
 * `baseline/abi/compatibility-matrix.json`). What differs per chain is which
 * extensions are usable. This module is the single source of truth for the
 * chain-specific extensions ("capabilities"), their deployment requirements,
 * and the decision on whether each non-swap extension ships in Setwise Router.
 *
 * A capability is available on a chain only when the chain config declares it
 * `enabled: true` AND its deployment requirement is satisfied (chain
 * restriction plus any required venues enabled). When a capability is
 * unavailable the corresponding router/quoter functions remain present in the
 * ABI — the bytecode is immutable — but revert before moving assets, because
 * the deployment surfaces no usable target addresses for the disabled
 * extension. See `docs/config/CAPABILITIES.md`.
 *
 * Terminology: keys are internal identifiers; UI labels live in
 * `CAPABILITY_DISPLAY_NAMES`.
 */

/**
 * Chain-specific extensions that every chain must declare explicitly (enabled
 * or not), mirroring the explicit-venue rule so unsupported extensions are
 * never implicit.
 */
export const KNOWN_CAPABILITIES = Object.freeze([
  "lidoStaking",
  "nameNft",
  "zammLiquidity",
  "ownership",
  "setwiseComposition",
]);

/**
 * Per-capability metadata and deployment requirements.
 *
 * @typedef {Object} CapabilityDefinition
 * @property {string} title            Human-readable label.
 * @property {"swap-support"|"extension"} scope  ABI scope bucket from the baseline.
 * @property {"ethereum-only"|"out-of-swap-scope"|"retain"|"disabled"} decision  Shipping decision.
 * @property {boolean} ethereumOnly    Deployment requirement: only chain id 1.
 * @property {readonly string[]} requiresVenues  Venues that must be enabled to deploy it.
 * @property {readonly string[]} functions  Router/quoter ABI functions this gates.
 * @property {string} rationale        Why the decision was made.
 */

/** @type {Readonly<Record<string, CapabilityDefinition>>} */
export const CAPABILITY_DEFINITIONS = Object.freeze({
  lidoStaking: Object.freeze({
    title: "Lido staking",
    scope: "swap-support",
    decision: "ethereum-only",
    ethereumOnly: true,
    requiresVenues: Object.freeze(["lido"]),
    functions: Object.freeze([
      "exactETHToSTETH",
      "exactETHToWSTETH",
      "ethToExactSTETH",
      "ethToExactWSTETH",
      "quoteLido",
    ]),
    rationale:
      "stETH/wstETH wrap-style routes depend on Lido, an Ethereum-mainnet product; gate behind a capability and drop on other chains.",
  }),
  nameNft: Object.freeze({
    title: ".wei NameNFT",
    scope: "extension",
    decision: "ethereum-only",
    ethereumOnly: true,
    requiresVenues: Object.freeze([]),
    functions: Object.freeze(["revealName", "onERC721Received"]),
    rationale:
      ".wei naming is an Ethereum-mainnet product; gate behind a capability flag and drop on other chains.",
  }),
  zammLiquidity: Object.freeze({
    title: "zAMM liquidity",
    scope: "extension",
    decision: "out-of-swap-scope",
    ethereumOnly: true,
    requiresVenues: Object.freeze(["zamm"]),
    functions: Object.freeze(["addLiquidity"]),
    rationale:
      "LP minting, not routing; preserved for Ethereum parity but excluded from non-Ethereum deployments and from Setwise swap execution.",
  }),
  ownership: Object.freeze({
    title: "Ownership",
    scope: "extension",
    decision: "retain",
    ethereumOnly: false,
    requiresVenues: Object.freeze([]),
    functions: Object.freeze(["transferOwnership"]),
    rationale:
      "Required for trust/ensureAllowance administration; retained on every chain and governed separately (issue #37).",
  }),
  setwiseComposition: Object.freeze({
    title: "Set composite routes",
    scope: "extension",
    decision: "disabled",
    ethereumOnly: false,
    requiresVenues: Object.freeze(["setwise"]),
    functions: Object.freeze(["multicall"]),
    rationale:
      "Mixed Set composite routes (a Set leg consuming transient credit staged by another venue) stay disabled until the composition audit lands; transaction-scoped credit accounting itself ships with issue #17 and only same-venue Set legs may produce it.",
  }),
});

/** UI-facing capability labels. Internal keys remain unchanged. */
export const CAPABILITY_DISPLAY_NAMES = Object.freeze(
  Object.fromEntries(
    KNOWN_CAPABILITIES.map((key) => [key, CAPABILITY_DEFINITIONS[key].title]),
  ),
);

/** Chain id that Ethereum-only capabilities are restricted to. */
export const ETHEREUM_CHAIN_ID = 1;

/**
 * @param {string} capability
 * @returns {CapabilityDefinition}
 */
export function capabilityDefinition(capability) {
  const definition = CAPABILITY_DEFINITIONS[capability];
  if (!definition) throw new Error(`unknown capability "${capability}"`);
  return definition;
}

/** @param {string} capability @returns {boolean} */
export function isEthereumOnlyCapability(capability) {
  return capabilityDefinition(capability).ethereumOnly;
}
