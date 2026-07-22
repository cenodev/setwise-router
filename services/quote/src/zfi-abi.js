/**
 * Generated-style ABI tooling for the ZFi on-chain quoter (issue #21).
 *
 * A small, dependency-free ABI coder driven by the pinned ABI baseline in
 * `baseline/abi/zQuoter.json` rather than hand-copied byte offsets. Function
 * selectors, parameter types, and return shapes all come from that single
 * source of truth, so the coder stays in lockstep with the compatibility
 * baseline captured in issue #5 and re-encoded byte-for-byte by
 * `test/abi-baseline.test.js`.
 *
 * The same coder also wraps the canonical Multicall3 `aggregate3` entry point
 * so the adapter can batch every route-builder read through the verified
 * Multicall3 deployment (`config/chains/<id>.json#multicall3`) in one call and
 * surface partial failures per route.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function loadJSON(relativePath) {
  return JSON.parse(readFileSync(join(here, relativePath), "utf8"));
}

const QUOTER_BASELINE = loadJSON("../../../baseline/abi/zQuoter.json");

function stripHex(value) {
  if (typeof value !== "string") throw new Error("expected a hex string");
  return value.startsWith("0x") ? value.slice(2) : value;
}

function hexToBytes(hex) {
  const clean = stripHex(hex);
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function encodeUint(value) {
  const big = BigInt(value);
  if (big < 0n) throw new Error("unsigned integer cannot be negative");
  const hex = big.toString(16);
  if (hex.length > 64) throw new Error("uint256 overflow");
  return hex.padStart(64, "0");
}

function encodeInt(value) {
  let big = BigInt(value);
  if (big < 0n) big = (1n << 256n) + big;
  if (big < 0n || big >= 1n << 256n) throw new Error("int256 overflow");
  return big.toString(16).padStart(64, "0");
}

function encodeAddress(value) {
  const hex = stripHex(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`invalid address: ${value}`);
  return hex.padStart(64, "0");
}

function encodeBytes(value) {
  const hex = stripHex(value);
  if (hex.length % 2 !== 0) throw new Error("bytes must have even length");
  const length = hex.length / 2;
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return encodeUint(BigInt(length)) + padded;
}

function readWord(data, offset) {
  if (offset + 32 > data.length) throw new Error("ABI decode out of bounds");
  let big = 0n;
  for (let i = 0; i < 32; i += 1) big = (big << 8n) | BigInt(data[offset + i]);
  return big;
}

function readInt(data, offset) {
  const big = readWord(data, offset);
  return big >= 1n << 255n ? big - (1n << 256n) : big;
}

function readAddress(data, offset) {
  return bytesToHex(data.slice(offset + 12, offset + 32));
}

/**
 * Split an ABI type string into its array shape.
 * @returns {{base: string, length: number|null}|null} `length === null` marks a
 *   dynamic `T[]`; `null` return means the type is not an array.
 */
function arrayInfo(type) {
  const dynamic = type.match(/^(.*)\[\]$/);
  if (dynamic) return { base: dynamic[1], length: null };
  const fixed = type.match(/^(.*)\[(\d+)\]$/);
  if (fixed) return { base: fixed[1], length: Number(fixed[2]) };
  return null;
}

function elementComponent(component) {
  return { type: arrayInfo(component.type).base, components: component.components };
}

/** True when an ABI type is dynamically sized (uses a head/tail offset). */
export function isDynamic(component) {
  const array = arrayInfo(component.type);
  if (array) {
    if (array.length === null) return true;
    return isDynamic(elementComponent(component));
  }
  if (component.type === "bytes" || component.type === "string") return true;
  if (component.type === "tuple") return component.components.some(isDynamic);
  return false;
}

/** Static byte size of a non-dynamic ABI type. */
export function staticSize(component) {
  const array = arrayInfo(component.type);
  if (array) return array.length * staticSize(elementComponent(component));
  if (component.type === "tuple") {
    return component.components.reduce((sum, c) => sum + staticSize(c), 0);
  }
  return 32;
}

function encodeValue(component, value) {
  const array = arrayInfo(component.type);
  if (array) {
    const element = elementComponent(component);
    const items = Array.from(value);
    if (array.length !== null && items.length !== array.length) {
      throw new Error(`expected ${array.length} elements, got ${items.length}`);
    }
    const body = encodeSequence(items.map(() => element), items);
    return array.length === null ? encodeUint(BigInt(items.length)) + body : body;
  }
  switch (component.type) {
    case "address":
      return encodeAddress(value);
    case "bool":
      return encodeUint(value ? 1n : 0n);
    case "bytes":
      return encodeBytes(value);
    case "tuple":
      return encodeSequence(component.components, componentValues(component, value));
    default:
      if (component.type.startsWith("uint")) return encodeUint(value);
      if (component.type.startsWith("int")) return encodeInt(value);
      throw new Error(`unsupported ABI type: ${component.type}`);
  }
}

function componentValues(component, value) {
  return component.components.map((c, i) =>
    Array.isArray(value) ? value[i] : value[c.name],
  );
}

/** Head/tail encode a sequence of typed values; returns hex without a 0x prefix. */
export function encodeSequence(components, values) {
  let headSize = 0;
  for (const component of components) {
    headSize += isDynamic(component) ? 32 : staticSize(component);
  }
  let head = "";
  let tail = "";
  let offset = headSize;
  components.forEach((component, i) => {
    if (isDynamic(component)) {
      head += encodeUint(BigInt(offset));
      const encoded = encodeValue(component, values[i]);
      tail += encoded;
      offset += encoded.length / 2;
    } else {
      head += encodeValue(component, values[i]);
    }
  });
  return head + tail;
}

/** Encode top-level call/return parameters (positional array or named object). */
export function encodeParams(components, values) {
  const positional = components.map((c, i) =>
    Array.isArray(values) ? values[i] : values[c.name],
  );
  return encodeSequence(components, positional);
}

function decodeValue(component, data, offset) {
  const array = arrayInfo(component.type);
  if (array) {
    const element = elementComponent(component);
    if (array.length === null) {
      const length = Number(readWord(data, offset));
      return decodeArray(element, length, data, offset + 32);
    }
    return decodeArray(element, array.length, data, offset);
  }
  switch (component.type) {
    case "address":
      return readAddress(data, offset);
    case "bool":
      return readWord(data, offset) !== 0n;
    case "bytes": {
      const length = Number(readWord(data, offset));
      return bytesToHex(data.slice(offset + 32, offset + 32 + length));
    }
    case "tuple":
      return decodeTuple(component.components, data, offset);
    default:
      if (component.type.startsWith("uint")) return readWord(data, offset).toString();
      if (component.type.startsWith("int")) return readInt(data, offset).toString();
      throw new Error(`unsupported ABI type: ${component.type}`);
  }
}

function decodeArray(element, length, data, offset) {
  const out = [];
  if (isDynamic(element)) {
    for (let i = 0; i < length; i += 1) {
      const pointer = Number(readWord(data, offset + i * 32));
      out.push(decodeValue(element, data, offset + pointer));
    }
  } else {
    const size = staticSize(element);
    for (let i = 0; i < length; i += 1) {
      out.push(decodeValue(element, data, offset + i * size));
    }
  }
  return out;
}

function decodeTuple(components, data, base) {
  const out = {};
  let head = 0;
  for (const component of components) {
    if (isDynamic(component)) {
      const pointer = Number(readWord(data, base + head));
      out[component.name] = decodeValue(component, data, base + pointer);
      head += 32;
    } else {
      out[component.name] = decodeValue(component, data, base + head);
      head += staticSize(component);
    }
  }
  return out;
}

/** Decode top-level return parameters into an object keyed by output name. */
export function decodeParams(components, returnData) {
  return decodeTuple(components, hexToBytes(returnData), 0);
}

// --- zQuoter function catalog (single source of truth: baseline/abi/zQuoter.json) ---

const FUNCTIONS_BY_NAME = new Map(
  QUOTER_BASELINE.abi.functions.map((fn) => [fn.name, fn]),
);

const ERROR_BY_SELECTOR = new Map(
  QUOTER_BASELINE.abi.errors.map((error) => [error.selector, error.name]),
);

/** @returns {string[]} the quoter function names known to the baseline ABI. */
export function quoterFunctionNames() {
  return [...FUNCTIONS_BY_NAME.keys()];
}

/** @returns {object} the baseline ABI entry for a quoter function. */
export function quoterFunction(name) {
  const fn = FUNCTIONS_BY_NAME.get(name);
  if (!fn) throw new Error(`unknown zQuoter function "${name}"`);
  return fn;
}

/** @returns {string} the 4-byte selector for a quoter function. */
export function quoterSelector(name) {
  return quoterFunction(name).selector;
}

/**
 * Map a revert selector to its ABI error name.
 * @param {string} selector 0x-prefixed 4-byte selector.
 * @returns {string|null}
 */
export function quoterErrorName(selector) {
  return ERROR_BY_SELECTOR.get(selector.toLowerCase()) ?? null;
}

/**
 * Encode a quoter view call.
 * @param {string} name quoter function name.
 * @param {Array|object} args positional array or object keyed by input name.
 * @returns {string} 0x-prefixed calldata.
 */
export function encodeQuoterCall(name, args) {
  const fn = quoterFunction(name);
  return `0x${stripHex(fn.selector)}${encodeParams(fn.inputs, args)}`;
}

/**
 * Decode a quoter view return payload.
 * @param {string} name quoter function name.
 * @param {string} returnData 0x-prefixed return bytes.
 * @returns {object} decoded outputs keyed by name.
 */
export function decodeQuoterResult(name, returnData) {
  const fn = quoterFunction(name);
  return decodeParams(fn.outputs, returnData);
}

/**
 * Encode a quoter view return payload. The inverse of {@link decodeQuoterResult};
 * handy for building deterministic fake transports and round-trip checks.
 * @param {string} name quoter function name.
 * @param {Array|object} values positional array or object keyed by output name.
 * @returns {string} 0x-prefixed return bytes.
 */
export function encodeQuoterResult(name, values) {
  const fn = quoterFunction(name);
  return `0x${encodeParams(fn.outputs, values)}`;
}

// --- Multicall3 aggregate3 batching ---

/** Canonical Multicall3 `aggregate3((address,bool,bytes)[])` selector. */
export const MULTICALL3_AGGREGATE3_SELECTOR = "0x82ad56cb";

const CALL3_COMPONENTS = Object.freeze([
  Object.freeze({ name: "target", type: "address" }),
  Object.freeze({ name: "allowFailure", type: "bool" }),
  Object.freeze({ name: "callData", type: "bytes" }),
]);

const RESULT_COMPONENTS = Object.freeze([
  Object.freeze({ name: "success", type: "bool" }),
  Object.freeze({ name: "returnData", type: "bytes" }),
]);

const AGGREGATE3_INPUTS = Object.freeze([
  Object.freeze({ name: "calls", type: "tuple[]", components: CALL3_COMPONENTS }),
]);

const AGGREGATE3_OUTPUTS = Object.freeze([
  Object.freeze({ name: "returnData", type: "tuple[]", components: RESULT_COMPONENTS }),
]);

/**
 * Encode a Multicall3 `aggregate3` call.
 * @param {Array<{target: string, allowFailure: boolean, callData: string}>} calls
 * @returns {string} 0x-prefixed calldata.
 */
export function encodeAggregate3(calls) {
  const body = encodeParams(AGGREGATE3_INPUTS, [calls]);
  return `${MULTICALL3_AGGREGATE3_SELECTOR}${body}`;
}

/**
 * Decode a Multicall3 `aggregate3` calldata payload into its calls. The inverse
 * of {@link encodeAggregate3}; used to inspect batched reads (e.g. in tests).
 * @param {string} calldata 0x-prefixed aggregate3 calldata.
 * @returns {Array<{target: string, allowFailure: boolean, callData: string}>}
 */
export function decodeAggregate3Calls(calldata) {
  const selector = MULTICALL3_AGGREGATE3_SELECTOR;
  if (!calldata.startsWith(selector)) throw new Error("not aggregate3 calldata");
  return decodeParams(AGGREGATE3_INPUTS, `0x${calldata.slice(selector.length)}`).calls;
}

/**
 * Decode a Multicall3 `aggregate3` return payload.
 * @param {string} returnData 0x-prefixed return bytes.
 * @returns {Array<{success: boolean, returnData: string}>} per-call results.
 */
export function decodeAggregate3(returnData) {
  return decodeParams(AGGREGATE3_OUTPUTS, returnData).returnData;
}

/**
 * Encode a Multicall3 `aggregate3` return payload. The inverse of
 * {@link decodeAggregate3}; handy for building deterministic fake transports.
 * @param {Array<{success: boolean, returnData: string}>} results
 * @returns {string} 0x-prefixed return bytes.
 */
export function encodeAggregate3Result(results) {
  return `0x${encodeParams(AGGREGATE3_OUTPUTS, [results])}`;
}
