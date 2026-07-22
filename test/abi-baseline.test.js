import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abiDir = join(root, "baseline", "abi");
const routesDir = join(root, "baseline", "routes");
const outDir = join(root, "zFi-main", "out");

const PINNED_BLOCK = 24_880_000;
const ROUTER_ADDRESS = "0x000000000000FB114709235f1ccBFfb925F600e4";
const SCOPES = new Set(["core-swap", "swap-support", "extension"]);
const SELECTOR_RE = /^0x[0-9a-f]{8}$/;
const TOPIC_RE = /^0x[0-9a-f]{64}$/;

function loadJSON(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

const router = loadJSON("baseline/abi/zRouter.json");
const quoter = loadJSON("baseline/abi/zQuoter.json");
const matrix = loadJSON("baseline/abi/compatibility-matrix.json");
const calldata = loadJSON("baseline/routes/calldata.json");
const execution = loadJSON("baseline/routes/execution.json");

// --- canonicalization (mirrors scripts/build-abi-baseline.mjs) ---

function canonType(input) {
  if (input.type === "tuple" || input.type.startsWith("tuple")) {
    const inner = `(${(input.components || []).map(canonType).join(",")})`;
    return inner + input.type.slice("tuple".length);
  }
  return input.type;
}

function canonSignature(name, inputs) {
  return `${name}(${(inputs || []).map(canonType).join(",")})`;
}

function stripInternal(param) {
  const out = { name: param.name, type: param.type };
  if (param.indexed) out.indexed = true;
  if (param.components) out.components = param.components.map(stripInternal);
  return out;
}

function sha256(text) {
  return `0x${createHash("sha256").update(text).digest("hex")}`;
}

function digestFromArtifact(contract) {
  const artifact = JSON.parse(readFileSync(join(outDir, `${contract}.sol`, `${contract}.json`), "utf8"));
  const functions = [];
  const events = [];
  const errors = [];
  let constructor = null;
  let receive = false;
  let fallback = false;
  for (const entry of artifact.abi) {
    if (entry.type === "function") {
      const signature = canonSignature(entry.name, entry.inputs);
      const selector = artifact.methodIdentifiers[signature];
      assert.ok(selector, `artifact missing methodIdentifier for ${contract}.${signature}`);
      functions.push({
        signature,
        selector: `0x${selector}`,
        stateMutability: entry.stateMutability,
        inputs: (entry.inputs || []).map(stripInternal),
        outputs: (entry.outputs || []).map(stripInternal),
      });
    } else if (entry.type === "event") {
      events.push(canonSignature(entry.name, entry.inputs));
    } else if (entry.type === "error") {
      errors.push(canonSignature(entry.name, entry.inputs));
    } else if (entry.type === "constructor") {
      constructor = { stateMutability: entry.stateMutability, inputs: (entry.inputs || []).map(stripInternal) };
    } else if (entry.type === "receive") {
      receive = true;
    } else if (entry.type === "fallback") {
      fallback = true;
    }
  }
  functions.sort((a, b) => a.selector.localeCompare(b.selector));
  events.sort();
  errors.sort();
  const deployedObject = artifact.deployedBytecode?.object ?? "0x";
  return {
    functions,
    events,
    errors,
    constructor,
    receive,
    fallback,
    deployedBytecodeSize: Math.max(0, (deployedObject.length - 2) / 2),
    deployedBytecodeHash: sha256(deployedObject),
  };
}

function digestFromFixture(record) {
  const functions = record.abi.functions
    .map((f) => ({
      signature: f.signature,
      selector: f.selector,
      stateMutability: f.stateMutability,
      inputs: f.inputs,
      outputs: f.outputs,
    }))
    .sort((a, b) => a.selector.localeCompare(b.selector));
  return {
    functions,
    events: record.abi.events.map((e) => e.signature).sort(),
    errors: record.abi.errors.map((e) => e.signature).sort(),
    constructor: record.abi.constructor,
    receive: record.abi.receive,
    fallback: record.abi.fallback,
    deployedBytecodeSize: record.deployedBytecodeSize,
    deployedBytecodeHash: record.deployedBytecodeHash,
  };
}

function resolveCast() {
  if (process.env.CAST_BIN) return process.env.CAST_BIN;
  const which = spawnSync("command", ["-v", "cast"], { shell: true, encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = join(process.env.HOME || "", ".foundry/bin/cast");
  return existsSync(fallback) ? fallback : null;
}

// ---------------------------------------------------------------------------
// 1. ABI fixture integrity (no external tooling required)
// ---------------------------------------------------------------------------

test("ABI fixtures are pinned to the upstream commit and well-formed", () => {
  for (const record of [router, quoter]) {
    assert.equal(record.upstreamCommit, matrix.upstream.commit);
    assert.match(record.upstreamCommit, /^[0-9a-f]{40}$/);
    assert.ok(Number.isInteger(record.deployedBytecodeSize) && record.deployedBytecodeSize > 0);
    assert.match(record.deployedBytecodeHash, /^0x[0-9a-f]{64}$/);

    const seen = new Set();
    for (const fn of record.abi.functions) {
      assert.match(fn.selector, SELECTOR_RE, `${fn.name} selector`);
      assert.ok(!seen.has(fn.selector), `duplicate selector ${fn.selector}`);
      seen.add(fn.selector);
      assert.equal(fn.signature, canonSignature(fn.name, fn.inputs), `${fn.name} signature canonical`);
      assert.ok(SCOPES.has(fn.scope), `${fn.name} scope ${fn.scope}`);
    }
    for (const ev of record.abi.events) assert.match(ev.topicHash, TOPIC_RE, `${ev.name} topic`);
    for (const er of record.abi.errors) assert.match(er.selector, SELECTOR_RE, `${er.name} selector`);
  }
});

test("every function is classified into exactly one preservation scope", () => {
  for (const [name, record] of [["zRouter", router], ["zQuoter", quoter]]) {
    const names = record.abi.functions.map((f) => f.name).sort();
    assert.equal(new Set(names).size, names.length, `${name} has duplicate function names`);
    const bucketed = Object.values(matrix.contracts[name].scope.byScope).flat().sort();
    assert.deepEqual(bucketed, names, `${name} scope buckets cover all functions exactly once`);
  }
  // The swap/extension boundary must be explicit and non-empty on the router.
  const routerScope = matrix.contracts.zRouter.scope.byScope;
  assert.ok(routerScope["core-swap"].length >= 7);
  assert.ok(routerScope.extension.includes("revealName"));
  assert.ok(routerScope.extension.includes("addLiquidity"));
});

// ---------------------------------------------------------------------------
// 2. ABI drift: committed fixtures must match the rebuilt pinned artifacts
// ---------------------------------------------------------------------------

test("zRouter/zQuoter ABI fixtures match the rebuilt pinned artifacts", (t) => {
  const routerArtifact = join(outDir, "zRouter.sol", "zRouter.json");
  const quoterArtifact = join(outDir, "zQuoter.sol", "zQuoter.json");
  if (!existsSync(routerArtifact) || !existsSync(quoterArtifact)) {
    t.skip("forge artifacts missing; run `npm run build` to enable the ABI drift check");
    return;
  }
  assert.deepEqual(digestFromFixture(router), digestFromArtifact("zRouter"), "zRouter ABI drifted from fixture");
  assert.deepEqual(digestFromFixture(quoter), digestFromArtifact("zQuoter"), "zQuoter ABI drifted from fixture");
});

// ---------------------------------------------------------------------------
// 3. Representative route calldata fixtures
// ---------------------------------------------------------------------------

test("calldata fixtures are consistent with the ABI baseline", () => {
  const abiByName = {};
  for (const record of [router, quoter]) {
    for (const fn of record.abi.functions) abiByName[`${record.contract}.${fn.name}`] = fn;
  }
  assert.ok(calldata.routes.length >= 20, "expected a broad representative route set");
  for (const route of calldata.routes) {
    const fn = abiByName[`${route.contract}.${route.function}`];
    assert.ok(fn, `${route.id}: ${route.function} not in ABI baseline`);
    assert.equal(route.signature, fn.signature, `${route.id} signature`);
    assert.equal(route.selector, fn.selector, `${route.id} selector`);
    assert.ok(route.calldata.startsWith(fn.selector), `${route.id} calldata selector prefix`);
    assert.equal(route.args.length, fn.inputs.length, `${route.id} arg count`);
    route.args.forEach((arg, i) => {
      assert.equal(arg.name, fn.inputs[i].name, `${route.id} arg[${i}] name`);
      assert.equal(arg.type, fn.inputs[i].type, `${route.id} arg[${i}] type`);
    });
  }
});

test("calldata fixtures re-encode byte-for-byte via cast", (t) => {
  const cast = resolveCast();
  if (!cast) {
    t.skip("cast not found; skipping calldata re-encode check");
    return;
  }
  for (const route of calldata.routes) {
    const res = spawnSync(cast, ["calldata", route.signature, ...route.args.map((a) => a.value)], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `${route.id}: cast calldata failed: ${res.stderr}`);
    assert.equal(res.stdout.trim(), route.calldata, `${route.id}: calldata drifted`);
  }
});

// ---------------------------------------------------------------------------
// 4. Execution / revert / gas fixtures captured on the pinned fork
// ---------------------------------------------------------------------------

test("execution fixtures are pinned, well-formed, and tied to the ABI baseline", () => {
  assert.equal(execution.capture.block, PINNED_BLOCK, "captures must stay on the pinned block");
  assert.equal(execution.capture.router.toLowerCase(), ROUTER_ADDRESS.toLowerCase());

  const quoterErrors = new Set(quoter.abi.errors.map((e) => e.selector));
  const kinds = { view: 0, exec: 0, revert: 0 };
  for (const cap of execution.captures) {
    kinds[cap.kind] += 1;
    assert.match(cap.returnData, /^0x[0-9a-f]*$/, `${cap.id} returnData hex`);
    if (cap.kind === "revert") {
      assert.equal(cap.ok, false, `${cap.id} should revert`);
      assert.match(cap.revertSelector, SELECTOR_RE, `${cap.id} revert selector`);
      assert.ok(quoterErrors.has(cap.revertSelector), `${cap.id} revert selector ${cap.revertSelector} not in zQuoter ABI`);
    }
    if (cap.kind === "exec") {
      assert.equal(cap.ok, true, `${cap.id} execution should succeed`);
      assert.ok(Number.isInteger(cap.gas) && cap.gas > 0, `${cap.id} gas`);
      assert.ok(BigInt(cap.received) > 0n, `${cap.id} received`);
    }
    if (cap.kind === "view") {
      assert.equal(cap.ok, true, `${cap.id} view call should succeed`);
      assert.ok(cap.returnData.length > 2, `${cap.id} return data`);
    }
  }
  assert.ok(kinds.view >= 1 && kinds.exec >= 1 && kinds.revert >= 1, "need view, exec, and revert captures");
});

test("recorded NoRoute/SlippageBpsTooHigh selectors match the ABI baseline", () => {
  const byName = Object.fromEntries(quoter.abi.errors.map((e) => [e.name, e.selector]));
  const noRoute = execution.captures.find((c) => c.id === "revert-noRoute-same-token");
  const slippage = execution.captures.find((c) => c.id === "revert-slippageBpsTooHigh");
  assert.equal(noRoute.revertSelector, byName.NoRoute);
  assert.equal(slippage.revertSelector, byName.SlippageBpsTooHigh);
});
