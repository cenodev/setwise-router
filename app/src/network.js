import { getChainOption } from "./chains.js";

/**
 * @param {import("./chains.js").ReturnType<typeof import("./chains.js").resolveNetworkState>} state
 */
export function describeNetworkState(state) {
  switch (state.status) {
    case "ready":
      return {
        title: getChainOption(state.walletChainId).displayName,
        description: "Wallet is connected on a supported network.",
        action: null,
      };
    case "disconnected":
      return {
        title: "Wallet not connected",
        description: state.message,
        action: "connect",
      };
    case "unsupported":
      return {
        title: "Unsupported network",
        description: state.message,
        action: "switch-supported",
      };
    case "wrong-chain":
      return {
        title: "Wrong network",
        description: state.message,
        action: "switch-selected",
      };
    default:
      return {
        title: "Network unavailable",
        description: "Unable to determine wallet network.",
        action: "retry",
      };
  }
}
