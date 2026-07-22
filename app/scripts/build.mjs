#!/usr/bin/env node
import { supportedChainIds } from "../../config/index.mjs";
import { loadTokenList } from "../src/tokens.js";
import { loadRobinhoodCanonicalMetadata } from "../src/robinhood.js";
import { listSupportedChains } from "../src/chains.js";

for (const chainId of supportedChainIds()) {
  loadTokenList(chainId);
}

loadRobinhoodCanonicalMetadata();
listSupportedChains();

console.log(
  `validated chain-scoped token lists for chains: ${supportedChainIds().join(", ")}`,
);
