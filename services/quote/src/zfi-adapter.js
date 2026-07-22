/**
 * Chain-aware ZFi on-chain quoter source adapter (issue #21).
 *
 * Wraps each chain's deployed ZFi-compatible quoter and route builders behind
 * the unified quote-source interface from `adapter.js` (issue #18), producing
 * normalized quotes that match the schema from `schema.js` (issue #20).
 *
 * Behavior:
 *   - Verifies the chain id (`eth_chainId`) and the quoter's deployment code
 *     (`eth_getCode`, optionally against an expected runtime bytecode hash)
 *     before any quote read, failing closed on a mismatch.
 *   - Batches every enabled route builder through the chain's verified
 *     Multicall3 deployment (`aggregate3` with per-call `allowFailure`), so a
 *     single reverting builder is reported per route instead of failing the
 *     whole quote.
 *   - Encodes/decodes through the generated ABI tooling in `zfi-abi.js`
 *     (driven by `baseline/abi/zQuoter.json`) rather than duplicated offsets.
 *   - Capability-gates unsupported route builders per chain (venues/capabilities
 *     plus explicit per-deployment overrides).
 *   - Returns executable router calldata (firm quotes) and structured route
 *     evidence; the quoter's special compiler/deployment constraints are
 *     preserved by reading the immutable deployed bytecode as-is.
 *
 * The adapter is transport-agnostic: it reads through a small injectable
 * transport so it can be exercised deterministically without an RPC endpoint.
 * `createRpcTransport` provides a JSON-RPC-backed implementation.
 */

import { getChainConfig } from "../../../config/index.mjs";
import { runtimeBytecodeHash } from "../../../deployments/bytecode.mjs";
import { rpcCall } from "../../../deployments/rpc.mjs";
import { QuoteSourceAdapter } from "./adapter.js";
import {
  decodeAggregate3,
  decodeQuoterResult,
  encodeAggregate3,
  encodeQuoterCall,
  quoterErrorName,
} from "./zfi-abi.js";

/** Stable error codes surfaced in ZFi route evidence. */
export const ZFI_ERROR_CODES = Object.freeze({
  NO_DEPLOYMENT: "ZFI_NO_DEPLOYMENT",
  NO_TRANSPORT: "ZFI_NO_TRANSPORT",
  CHAIN_MISMATCH: "ZFI_CHAIN_MISMATCH",
  NO_CODE: "ZFI_NO_CODE",
  CODE_MISMATCH: "ZFI_CODE_MISMATCH",
  NO_ROUTES: "ZFI_NO_ROUTES",
  MULTICALL_FAILED: "ZFI_MULTICALL_FAILED",
  ROUTE_REVERTED: "ZFI_ROUTE_REVERTED",
});

function sumLegs(legs, key) {
  return legs.reduce((sum, leg) => sum + BigInt(leg[key]), 0n).toString();
}

/**
 * Route builders keyed by their canonical shape. Each builder maps a quote
 * request onto a quoter view function and interprets its decoded return into a
 * uniform `{ amountIn, amountOut, calldata, msgValue, limit?, legs }` route.
 */
export const ZFI_ROUTE_BUILDERS = Object.freeze({
  direct: Object.freeze({
    label: "direct",
    fn: "buildBestSwap",
    modes: Object.freeze(["exact-input", "exact-output"]),
    encode: (p) => [p.to, p.exactOut, p.tokenIn, p.tokenOut, p.swapAmount, p.slippageBps, p.deadline],
    route: (d) => ({
      amountIn: d.best.amountIn,
      amountOut: d.best.amountOut,
      calldata: d.callData,
      msgValue: d.msgValue,
      limit: d.amountLimit,
      legs: [d.best],
    }),
  }),
  multiHop: Object.freeze({
    label: "multi-hop",
    fn: "buildBestSwapViaETHMulticall",
    modes: Object.freeze(["exact-input", "exact-output"]),
    encode: (p) => [p.to, p.refundTo, p.exactOut, p.tokenIn, p.tokenOut, p.swapAmount, p.slippageBps, p.deadline],
    route: (d) => ({
      amountIn: d.a.amountIn,
      amountOut: d.b.amountOut,
      calldata: d.multicall,
      msgValue: d.msgValue,
      legs: [d.a, d.b],
    }),
  }),
  threeHop: Object.freeze({
    label: "three-hop",
    fn: "build3HopMulticall",
    modes: Object.freeze(["exact-input", "exact-output"]),
    encode: (p) => [p.to, p.exactOut, p.tokenIn, p.tokenOut, p.swapAmount, p.slippageBps, p.deadline],
    route: (d) => ({
      amountIn: d.a.amountIn,
      amountOut: d.c.amountOut,
      calldata: d.multicall,
      msgValue: d.msgValue,
      legs: [d.a, d.b, d.c],
    }),
  }),
  split: Object.freeze({
    label: "split",
    fn: "buildSplitSwap",
    modes: Object.freeze(["exact-input"]),
    encode: (p) => [p.to, p.tokenIn, p.tokenOut, p.swapAmount, p.slippageBps, p.deadline],
    route: (d) => ({
      amountIn: sumLegs(d.legs, "amountIn"),
      amountOut: sumLegs(d.legs, "amountOut"),
      calldata: d.multicall,
      msgValue: d.msgValue,
      legs: [...d.legs],
    }),
  }),
  hybrid: Object.freeze({
    label: "hybrid",
    fn: "buildHybridSplit",
    modes: Object.freeze(["exact-input"]),
    encode: (p) => [p.to, p.tokenIn, p.tokenOut, p.swapAmount, p.slippageBps, p.deadline],
    route: (d) => ({
      amountIn: sumLegs(d.legs, "amountIn"),
      amountOut: sumLegs(d.legs, "amountOut"),
      calldata: d.multicall,
      msgValue: d.msgValue,
      legs: [...d.legs],
    }),
  }),
});

const SWAP_VENUES = new Set([
  "uniswapV2",
  "uniswapV3",
  "uniswapV4",
  "sushiswap",
  "pancakeSwap",
  "curve",
  "lido",
  "zamm",
]);

function enabledSwapVenueCount(chainConfig) {
  const venues = chainConfig.venues ?? {};
  let count = 0;
  for (const [name, venue] of Object.entries(venues)) {
    if (SWAP_VENUES.has(name) && venue && venue.enabled === true) count += 1;
  }
  return count;
}

/**
 * Default per-chain route-builder policy derived from the chain config: core
 * single-path builders need at least one enabled swap venue, while split/hybrid
 * need at least two venues to split across.
 * @param {object} chainConfig
 * @returns {Record<string, boolean>}
 */
export function defaultRoutePolicy(chainConfig) {
  const venues = enabledSwapVenueCount(chainConfig);
  return {
    direct: venues >= 1,
    multiHop: venues >= 1,
    threeHop: venues >= 1,
    split: venues >= 2,
    hybrid: venues >= 2,
  };
}

function enabledBuilders(chainConfig, deployment, mode) {
  const policy = defaultRoutePolicy(chainConfig);
  const overrides = deployment?.routes ?? {};
  const enabled = [];
  for (const [name, builder] of Object.entries(ZFI_ROUTE_BUILDERS)) {
    if (!builder.modes.includes(mode)) continue;
    const allowed = name in overrides ? overrides[name] === true : policy[name] === true;
    if (allowed) enabled.push(name);
  }
  return enabled;
}

function routeLimit(mode, route, slippageBps) {
  if (route.limit !== undefined && route.limit !== null) return route.limit;
  const bps = BigInt(slippageBps);
  if (mode === "exact-input") {
    return ((BigInt(route.amountOut) * (10000n - bps)) / 10000n).toString();
  }
  return ((BigInt(route.amountIn) * (10000n + bps) + 9999n) / 10000n).toString();
}

function revertDetail(returnData) {
  if (typeof returnData !== "string" || returnData.length < 10) {
    return { code: ZFI_ERROR_CODES.ROUTE_REVERTED, message: "route builder reverted" };
  }
  const selector = returnData.slice(0, 10).toLowerCase();
  const name = quoterErrorName(selector);
  return name
    ? { code: name, message: `route builder reverted: ${name}` }
    : { code: ZFI_ERROR_CODES.ROUTE_REVERTED, message: `route builder reverted: ${selector}` };
}

/**
 * @typedef {Object} ZfiDeployment
 * @property {string} quoter            Deployed ZFi-compatible quoter address.
 * @property {string} [codeHash]        Expected runtime bytecode hash (optional).
 * @property {Record<string, boolean>} [routes]  Per-builder enable overrides.
 */

/**
 * @typedef {Object} ZfiTransport
 * @property {() => Promise<number>} getChainId
 * @property {(address: string) => Promise<string>} getCode
 * @property {(to: string, data: string) => Promise<string>} call
 * @property {() => Promise<string>} [getBlockNumber]
 * @property {(to: string, data: string, value: string) => Promise<string>} [estimateGas]
 */

export class ZfiQuoteAdapter extends QuoteSourceAdapter {
  /**
   * @param {object} descriptor  See {@link QuoteSourceAdapter}; type must be "zfi".
   * @param {object} options
   * @param {ZfiTransport} options.transport  Chain read transport.
   * @param {Record<number, ZfiDeployment>} options.deployments  Per-chain bindings.
   * @param {Partial<import("./adapter.js").AdapterCapabilities>} [options.capabilities]
   * @param {(code: string) => string} [options.hashCode]  Runtime bytecode hasher.
   * @param {number} [options.deadlineTtlSeconds]
   * @param {number} [options.firmTtlMs]
   * @param {number} [options.timeoutMs]
   */
  constructor(descriptor, options = {}) {
    if (descriptor?.type !== "zfi") {
      throw new Error("ZfiQuoteAdapter requires a descriptor of type \"zfi\"");
    }
    const deployments = options.deployments ?? {};
    const capabilities = options.capabilities ?? {
      chains: Object.keys(deployments).map((id) => Number(id)),
    };
    super(descriptor, { ...options, capabilities });
    this.transport = options.transport ?? null;
    this.deployments = deployments;
    this.hashCode = options.hashCode ?? runtimeBytecodeHash;
    this.deadlineTtlSeconds = options.deadlineTtlSeconds ?? 300;
    this.firmTtlMs = options.firmTtlMs ?? 60_000;
  }

  async health(context) {
    const checkedAt = context?.now ? context.now() : new Date().toISOString();
    const start = performance.now();
    if (!this.transport) {
      return { status: "unhealthy", checkedAt, latencyMs: 0, detail: "no transport configured" };
    }
    try {
      await this.transport.getChainId();
      return { status: "healthy", checkedAt, latencyMs: Math.round(performance.now() - start) };
    } catch (error) {
      return {
        status: "unhealthy",
        checkedAt,
        latencyMs: Math.round(performance.now() - start),
        detail: error?.message ?? "transport probe failed",
      };
    }
  }

  async quote(request, context) {
    const observedAt = context.now();
    const chainConfig = context.chainConfig ?? getChainConfig(request.chainId);
    const deployment = this.deployments[request.chainId];

    if (!deployment) {
      return this.unavailable(ZFI_ERROR_CODES.NO_DEPLOYMENT, `no ZFi deployment configured for chain ${request.chainId}`, observedAt);
    }
    if (!this.transport) {
      return this.unavailable(ZFI_ERROR_CODES.NO_TRANSPORT, "no chain transport configured", observedAt);
    }

    const verified = await this.verifyDeployment(request.chainId, deployment, observedAt);
    if (verified) return verified;

    const builders = enabledBuilders(chainConfig, deployment, request.mode);
    if (builders.length === 0) {
      return this.unavailable(ZFI_ERROR_CODES.NO_ROUTES, `no route builders enabled for ${request.mode} on chain ${request.chainId}`, observedAt);
    }

    const params = this.callParams(request, context);
    const calls = builders.map((name) => ({
      target: deployment.quoter,
      allowFailure: true,
      callData: encodeQuoterCall(ZFI_ROUTE_BUILDERS[name].fn, ZFI_ROUTE_BUILDERS[name].encode(params)),
    }));

    let results;
    try {
      const returnData = await this.transport.call(chainConfig.multicall3, encodeAggregate3(calls));
      results = decodeAggregate3(returnData);
    } catch (error) {
      return this.unavailable(ZFI_ERROR_CODES.MULTICALL_FAILED, error?.message ?? "multicall failed", observedAt);
    }

    const blockNumber = await this.readBlockNumber();
    return this.assemble(request, context, builders, results, observedAt, blockNumber);
  }

  /** Best-effort block number for evidence provenance; undefined when unavailable. */
  async readBlockNumber() {
    if (typeof this.transport.getBlockNumber !== "function") return undefined;
    try {
      return await this.transport.getBlockNumber();
    } catch {
      return undefined;
    }
  }

  /**
   * Verify chain id and deployment code before any quote read. Returns an
   * unavailable result on failure, or null when verification passes.
   */
  async verifyDeployment(chainId, deployment, observedAt) {
    let actualChainId;
    try {
      actualChainId = await this.transport.getChainId();
    } catch (error) {
      return this.unavailable(ZFI_ERROR_CODES.CHAIN_MISMATCH, error?.message ?? "chain id probe failed", observedAt);
    }
    if (actualChainId !== chainId) {
      return this.unavailable(ZFI_ERROR_CODES.CHAIN_MISMATCH, `transport reports chain ${actualChainId}, expected ${chainId}`, observedAt);
    }

    let code;
    try {
      code = await this.transport.getCode(deployment.quoter);
    } catch (error) {
      return this.unavailable(ZFI_ERROR_CODES.NO_CODE, error?.message ?? "code probe failed", observedAt);
    }
    if (typeof code !== "string" || code === "0x" || code.length <= 2) {
      return this.unavailable(ZFI_ERROR_CODES.NO_CODE, `no contract code at quoter ${deployment.quoter}`, observedAt);
    }
    if (deployment.codeHash) {
      const actual = this.hashCode(code);
      if (actual.toLowerCase() !== deployment.codeHash.toLowerCase()) {
        return this.unavailable(ZFI_ERROR_CODES.CODE_MISMATCH, `quoter bytecode hash ${actual} does not match expected ${deployment.codeHash}`, observedAt);
      }
    }
    return null;
  }

  callParams(request, context) {
    const nowSeconds = Math.floor(Date.parse(context.now()) / 1000);
    return {
      to: request.recipient.address,
      refundTo: request.funder.address,
      exactOut: request.mode === "exact-output",
      tokenIn: request.tokenIn.address,
      tokenOut: request.tokenOut.address,
      swapAmount: request.amount,
      slippageBps: request.slippage.maxBps,
      deadline: BigInt(nowSeconds + this.deadlineTtlSeconds).toString(),
    };
  }

  assemble(request, context, builders, results, observedAt, blockNumber) {
    const mode = request.mode;
    const slippageBps = request.slippage.maxBps;
    const evidence = [];
    const candidates = [];

    builders.forEach((name, index) => {
      const builder = ZFI_ROUTE_BUILDERS[name];
      const reference = `${this.id}:${builder.label}`;
      const result = results[index];
      const base = { kind: "onchain", observedAt, reference };
      if (blockNumber) base.blockNumber = blockNumber;

      if (!result || result.success !== true) {
        const detail = revertDetail(result?.returnData);
        evidence.push({ ...base, code: detail.code, message: detail.message });
        return;
      }

      let route;
      try {
        route = builder.route(decodeQuoterResult(builder.fn, result.returnData));
      } catch (error) {
        evidence.push({ ...base, code: ZFI_ERROR_CODES.ROUTE_REVERTED, message: `undecodable route: ${error?.message ?? "decode failed"}` });
        return;
      }
      evidence.push(base);
      candidates.push({ name, route });
    });

    if (candidates.length === 0) {
      return { status: "unavailable", quote: null, evidence };
    }

    const best = this.selectBest(mode, candidates);
    const quote = this.buildQuote(request, context, best.route, slippageBps, observedAt);
    const result = { status: "available", quote, evidence };
    if (context.kind === "firm") {
      result.transaction = this.buildTransaction(request, best.route);
    }
    return result;
  }

  selectBest(mode, candidates) {
    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (mode === "exact-output") {
        if (BigInt(candidate.route.amountIn) < BigInt(best.route.amountIn)) best = candidate;
      } else if (BigInt(candidate.route.amountOut) > BigInt(best.route.amountOut)) {
        best = candidate;
      }
    }
    return best;
  }

  buildQuote(request, context, route, slippageBps, observedAt) {
    const firm = context.kind === "firm";
    const observed = Date.parse(observedAt);
    return {
      kind: context.kind,
      amounts: {
        input: route.amountIn,
        output: route.amountOut,
        limit: routeLimit(request.mode, route, slippageBps),
      },
      gas: {
        estimatedUnits: "0",
        estimatedCost: "0",
      },
      fees: [],
      approvalTarget: firm ? request.router : null,
      expiresAt: firm ? new Date(observed + this.firmTtlMs).toISOString() : null,
    };
  }

  buildTransaction(request, route) {
    return {
      chainId: request.chainId,
      to: request.router.address,
      calldata: route.calldata,
      value: route.msgValue,
    };
  }

  unavailable(code, message, observedAt) {
    return {
      status: "unavailable",
      quote: null,
      evidence: [{ kind: "onchain", observedAt, reference: `${this.id}:deployment`, code, message }],
    };
  }
}

/**
 * Create a JSON-RPC-backed transport. Chain-id verification is the adapter's
 * responsibility; this transport only issues raw reads.
 *
 * @param {string} rpcUrl
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {ZfiTransport}
 */
export function createRpcTransport(rpcUrl, options = {}) {
  const { fetchImpl, signal } = options;
  const call = (method, params) => rpcCall(rpcUrl, method, params, { fetchImpl, signal });
  return {
    async getChainId() {
      const raw = await call("eth_chainId", []);
      return Number.parseInt(String(raw), 16);
    },
    async getCode(address) {
      return call("eth_getCode", [address, "latest"]);
    },
    async call(to, data) {
      return call("eth_call", [{ to, data }, "latest"]);
    },
    async getBlockNumber() {
      const raw = await call("eth_blockNumber", []);
      return String(Number.parseInt(String(raw), 16));
    },
    async estimateGas(to, data, value) {
      const tx = { to, data };
      if (value && value !== "0") tx.value = `0x${BigInt(value).toString(16)}`;
      const raw = await call("eth_estimateGas", [tx]);
      return BigInt(raw).toString();
    },
  };
}
