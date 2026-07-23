import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeQuoterResult,
  encodeQuoterCall,
  encodeQuoterResult,
  quoterErrorName,
} from "../../services/quote/src/zfi-abi.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function comparable(value) {
  return JSON.stringify(value);
}

function pick(object, fields) {
  return Object.fromEntries(fields.map((field) => [field, object[field]]));
}

function routeArgumentValue(argument) {
  if (argument.type === "bool") return argument.value === true || argument.value === "true";
  return argument.value;
}

function decodedFields(functionName, returnData) {
  const decoded = decodeQuoterResult(functionName, returnData);
  if (functionName === "getQuotes") {
    return {
      selectedSources: [
        decoded.best.source,
        ...decoded.quotes.filter((quote) => BigInt(quote.amountOut) > 0n).map((quote) => quote.source),
      ],
      amounts: {
        amountIn: decoded.best.amountIn,
        amountOut: decoded.best.amountOut,
      },
    };
  }
  if (functionName === "buildBestSwap") {
    return {
      selectedSources: [decoded.best.source],
      amounts: {
        amountIn: decoded.best.amountIn,
        amountOut: decoded.best.amountOut,
        amountLimit: decoded.amountLimit,
        msgValue: decoded.msgValue,
      },
      executionCalldata: decoded.callData,
    };
  }
  if (functionName === "quoteLido") {
    return {
      amounts: {
        amountIn: decoded.amountIn,
        amountOut: decoded.amountOut,
      },
    };
  }
  if (functionName === "quoteCurve") {
    return {
      amounts: {
        amountIn: decoded.amountIn,
        amountOut: decoded.amountOut,
      },
    };
  }
  return {};
}

function sourceFields(capture, route) {
  const result = {};
  if (route) result.requestCalldata = route.calldata;
  if (capture) {
    result.returnData = capture.returnData;
    if (route?.contract === "zQuoter" && capture.kind === "view") {
      Object.assign(result, decodedFields(route.function, capture.returnData));
    } else {
      if (capture.source !== undefined) result.selectedSources = [String(capture.source)];
      if (capture.amountIn !== undefined || capture.amountOut !== undefined) {
        result.amounts = {
          amountIn: capture.amountIn,
          amountOut: capture.amountOut,
        };
      }
    }
    if (capture.received !== undefined) result.recipientDelta = capture.received;
    if (capture.kind === "revert") {
      const selector = capture.returnData.slice(0, 10).toLowerCase();
      result.revert = {
        selector,
        name: quoterErrorName(selector),
      };
    }
    if (Number.isInteger(capture.gas) && capture.gas > 0) result.gas = capture.gas;
  }
  return result;
}

function setwiseFields(capture, route) {
  const result = {};
  if (route) {
    result.requestCalldata =
      route.contract === "zQuoter"
        ? encodeQuoterCall(route.function, route.args.map(routeArgumentValue))
        : route.calldata;
  }
  if (capture) {
    if (route?.contract === "zQuoter" && capture.kind === "view") {
      const decoded = decodeQuoterResult(route.function, capture.returnData);
      result.returnData = encodeQuoterResult(route.function, decoded);
      Object.assign(result, decodedFields(route.function, result.returnData));
    } else {
      result.returnData = capture.returnData;
      if (capture.source !== undefined) result.selectedSources = [String(capture.source)];
      if (capture.amountIn !== undefined || capture.amountOut !== undefined) {
        result.amounts = {
          amountIn: capture.amountIn,
          amountOut: capture.amountOut,
        };
      }
    }
    if (capture.received !== undefined) result.recipientDelta = capture.received;
    if (capture.kind === "revert") {
      const selector = capture.returnData.slice(0, 10).toLowerCase();
      result.revert = {
        selector,
        name: quoterErrorName(selector),
      };
    }
    if (Number.isInteger(capture.gas) && capture.gas > 0) result.gas = capture.gas;
  }
  return result;
}

export function loadDifferentialInputs() {
  const manifest = readJson("baseline/differential/ethereum.json");
  return {
    manifest,
    allowlist: readJson(manifest.allowlist),
    calldata: readJson("baseline/routes/calldata.json"),
    execution: readJson("baseline/routes/execution.json"),
  };
}

export function buildSnapshots(inputs = loadDifferentialInputs()) {
  const routeById = new Map(inputs.calldata.routes.map((route) => [route.id, route]));
  const captureById = new Map(inputs.execution.captures.map((capture) => [capture.id, capture]));
  const upstream = {};
  const setwise = {};

  for (const item of inputs.manifest.cases) {
    const route = item.routeId ? routeById.get(item.routeId) : undefined;
    const capture = item.captureId ? captureById.get(item.captureId) : undefined;
    if (item.routeId && !route) throw new Error(`${item.id}: missing route ${item.routeId}`);
    if (item.captureId && !capture) throw new Error(`${item.id}: missing capture ${item.captureId}`);

    const related = (item.relatedRouteIds ?? []).map((id) => {
      const relatedRoute = routeById.get(id);
      if (!relatedRoute) throw new Error(`${item.id}: missing related route ${id}`);
      return relatedRoute.calldata;
    });
    const expected = sourceFields(capture, route);
    const actual = setwiseFields(capture, route);
    if (related.length > 0) {
      expected.relatedCalldata = related;
      actual.relatedCalldata = related;
    }
    upstream[item.id] = pick(expected, item.checks);
    setwise[item.id] = pick(actual, item.checks);
  }
  return { upstream, setwise };
}

function validateAllowlistEntry(entry) {
  for (const field of ["caseId", "field", "upstream", "setwise", "rationale", "approvedBy", "approvedAt"]) {
    if (!(field in entry)) throw new Error(`allowlist entry missing ${field}`);
  }
  if (entry.caseId.includes("*") || entry.field.includes("*")) {
    throw new Error("allowlist wildcards are forbidden");
  }
  if (typeof entry.rationale !== "string" || entry.rationale.trim().length < 20) {
    throw new Error(`${entry.caseId}.${entry.field}: rationale must explain the intentional deviation`);
  }
  if (typeof entry.approvedBy !== "string" || entry.approvedBy.trim().length === 0) {
    throw new Error(`${entry.caseId}.${entry.field}: approvedBy is required`);
  }
  if (!Number.isFinite(Date.parse(entry.approvedAt))) {
    throw new Error(`${entry.caseId}.${entry.field}: approvedAt must be an ISO date`);
  }
}

export function compareSnapshots(upstream, setwise, allowlist, gasPolicy) {
  const deviations = allowlist.deviations ?? [];
  deviations.forEach(validateAllowlistEntry);
  const used = new Set();
  const errors = [];
  const warnings = [];
  const gas = [];

  for (const caseId of Object.keys(upstream)) {
    if (!(caseId in setwise)) {
      errors.push(`${caseId}: missing Setwise result`);
      continue;
    }
    for (const [field, expected] of Object.entries(upstream[caseId])) {
      const actual = setwise[caseId][field];
      if (field === "gas" && typeof expected === "number" && typeof actual === "number") {
        const delta = actual - expected;
        const deltaBps = expected === 0 ? 0 : Math.trunc((delta * 10_000) / expected);
        gas.push({ caseId, upstream: expected, setwise: actual, delta, deltaBps });
        if (deltaBps > gasPolicy.failRegressionBps) {
          errors.push(`${caseId}.gas: ${deltaBps} bps regression exceeds ${gasPolicy.failRegressionBps}`);
        } else if (deltaBps > gasPolicy.warnRegressionBps) {
          warnings.push(`${caseId}.gas: ${deltaBps} bps regression exceeds ${gasPolicy.warnRegressionBps}`);
        }
        continue;
      }
      if (comparable(expected) === comparable(actual)) continue;
      const index = deviations.findIndex(
        (entry) =>
          entry.caseId === caseId &&
          entry.field === field &&
          comparable(entry.upstream) === comparable(expected) &&
          comparable(entry.setwise) === comparable(actual),
      );
      if (index >= 0) {
        used.add(index);
      } else {
        errors.push(
          `${caseId}.${field}: upstream=${comparable(expected)} setwise=${comparable(actual)}`,
        );
      }
    }
  }
  deviations.forEach((entry, index) => {
    if (!used.has(index)) errors.push(`${entry.caseId}.${entry.field}: stale allowlist entry`);
  });
  return { ok: errors.length === 0, errors, warnings, gas, allowlisted: used.size };
}

export function validateManifest(inputs = loadDifferentialInputs()) {
  const { manifest, calldata, execution } = inputs;
  const errors = [];
  if (manifest.fork.chainId !== 1) errors.push("differential fork must use Ethereum chain id 1");
  if (manifest.fork.block !== execution.capture.block) errors.push("fork block drifted from execution fixture");
  if (manifest.upstream.commit !== calldata.upstream.commit) errors.push("calldata upstream commit mismatch");
  if (manifest.upstream.commit !== execution.upstream.commit) errors.push("execution upstream commit mismatch");
  const categories = new Set(manifest.cases.map((item) => item.category));
  for (const category of manifest.requiredCategories) {
    if (!categories.has(category)) errors.push(`missing required category ${category}`);
  }
  const ids = manifest.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) errors.push("differential case ids must be unique");
  for (const item of manifest.cases) {
    if (!Array.isArray(item.checks) || item.checks.length === 0) {
      errors.push(`${item.id}: checks must be non-empty`);
    }
  }
  return errors;
}
