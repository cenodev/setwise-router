import assert from "node:assert/strict";
import test from "node:test";

import { SETWISE_UI_LABEL } from "../src/constants.js";
import { describeNetworkState } from "../src/network.js";
import { loadAppConfig, resolveNetworkState } from "../src/chains.js";

test("unsupported network state includes a recoverable switch action", () => {
  const state = resolveNetworkState(42161);
  const ui = describeNetworkState(state);
  assert.equal(ui.title, "Unsupported network");
  assert.equal(ui.action, "switch-supported");
});

test("wrong-chain state prompts switching to the selected network", () => {
  const state = resolveNetworkState(1, 56);
  const ui = describeNetworkState(state);
  assert.equal(ui.title, "Wrong network");
  assert.equal(ui.action, "switch-selected");
});

test("app config uses Set for the Setwise venue label", () => {
  const config = loadAppConfig();
  assert.equal(SETWISE_UI_LABEL, "Set");
  assert.equal(config.chains[1].venues.setwise.displayName, "Set");
  assert.ok("setwise" in config.chains[1].venues);
});
