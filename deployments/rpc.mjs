/**
 * Minimal JSON-RPC client with mandatory chain-id verification.
 */

export class RpcChainMismatchError extends Error {
  constructor(expected, actual, rpcUrl) {
    super(
      `RPC chain id mismatch for ${rpcUrl}: expected ${expected}, got ${actual}. ` +
        "Refusing to read or verify against the wrong chain.",
    );
    this.name = "RpcChainMismatchError";
    this.expectedChainId = expected;
    this.actualChainId = actual;
    this.rpcUrl = rpcUrl;
  }
}

export class RpcError extends Error {
  constructor(message, { code, data, method, rpcUrl } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
    this.method = method;
    this.rpcUrl = rpcUrl;
  }
}

/**
 * @param {string} rpcUrl
 * @param {string} method
 * @param {unknown[]} [params]
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function rpcCall(rpcUrl, method, params = [], options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new RpcError(`HTTP ${response.status} from ${rpcUrl}`, { method, rpcUrl });
  }
  const body = await response.json();
  if (body.error) {
    throw new RpcError(body.error.message ?? "RPC error", {
      code: body.error.code,
      data: body.error.data,
      method,
      rpcUrl,
    });
  }
  return body.result;
}

/**
 * Read `eth_chainId` and fail closed when it does not match the configured id.
 *
 * @param {string} rpcUrl
 * @param {number} expectedChainId
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<number>}
 */
export async function assertRpcChainId(rpcUrl, expectedChainId, options = {}) {
  const raw = await rpcCall(rpcUrl, "eth_chainId", [], options);
  const actual = Number.parseInt(String(raw), 16);
  if (!Number.isInteger(actual) || actual !== expectedChainId) {
    throw new RpcChainMismatchError(expectedChainId, actual, rpcUrl);
  }
  return actual;
}

/**
 * @param {string} rpcUrl
 * @param {string} address
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string>}
 */
export async function getCode(rpcUrl, address, options = {}) {
  return rpcCall(rpcUrl, "eth_getCode", [address, "latest"], options);
}

/**
 * @param {string} rpcUrl
 * @param {string} address
 * @param {string} slot
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string>}
 */
export async function getStorageAt(rpcUrl, address, slot, options = {}) {
  return rpcCall(rpcUrl, "eth_getStorageAt", [address, slot, "latest"], options);
}

/**
 * Resolve an RPC URL for a chain config without reading private keys.
 *
 * @param {import("../config/schema.mjs").ChainConfig} chainConfig
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function resolvePublicRpcUrl(chainConfig, env = process.env) {
  const fromEnv = env[chainConfig.rpc.primaryEnv];
  if (typeof fromEnv === "string" && /^https?:\/\//.test(fromEnv)) return fromEnv;
  if (typeof chainConfig.rpc.publicUrl === "string" && chainConfig.rpc.publicUrl.length > 0) {
    return chainConfig.rpc.publicUrl;
  }
  return null;
}
