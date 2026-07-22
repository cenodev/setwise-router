import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function loadYamlish(rel) {
  // Enough structure for assertions without a YAML dependency.
  return read(rel);
}

test("CI workflows exist and pin action majors", () => {
  const ci = loadYamlish(".github/workflows/ci.yml");
  const fork = loadYamlish(".github/workflows/ci-fork.yml");

  assert.match(ci, /name:\s*CI\b/);
  assert.match(ci, /name:\s*baseline/);
  assert.match(ci, /actions\/checkout@v4/);
  assert.match(ci, /actions\/setup-node@v4/);
  assert.match(ci, /foundry-rs\/foundry-toolchain@v1/);
  assert.match(ci, /node-version-file:\s*\.node-version/);
  assert.match(ci, /cache:\s*npm/);
  assert.match(ci, /submodules:\s*recursive/);
  assert.match(ci, /check:bytecode/);
  assert.match(ci, /test:contracts/);
  assert.match(ci, /\.foundry-version/);

  assert.match(fork, /name:\s*CI Fork/);
  assert.match(fork, /name:\s*fork/);
  assert.match(fork, /continue-on-error:\s*true/);
  assert.match(fork, /test-contracts-fork\.mjs/);
  assert.match(fork, /FOUNDRY_ETH_RPC_URL/);
  assert.doesNotMatch(fork, /pull_request:/);
});

test("CI workflows require no production secrets", () => {
  const workflowsDir = join(root, ".github", "workflows");
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml"));
  assert.ok(files.length >= 2, "expected ci.yml and ci-fork.yml");

  for (const file of files) {
    const body = read(join(".github", "workflows", file));
    assert.doesNotMatch(
      body,
      /\$\{\{\s*secrets\./,
      `${file} must not reference secrets.*`,
    );
    assert.doesNotMatch(body, /DEPLOYER_PRIVATE_KEY|ETHERSCAN_API_KEY/);
  }
});

test("root package.json exposes CI entrypoints", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const script of [
    "lint",
    "typecheck",
    "format",
    "test",
    "test:services",
    "test:contracts",
    "build:contracts",
    "build:contracts:zquoter",
    "check:bytecode",
    "check",
  ]) {
    assert.ok(pkg.scripts[script], `missing script: ${script}`);
  }
});

test("bytecode gate and forge helpers are present", () => {
  for (const rel of [
    "scripts/check-bytecode-size.mjs",
    "scripts/build-zquoter-profile.mjs",
    "scripts/test-contracts.mjs",
    "scripts/test-contracts-fork.mjs",
    "scripts/lib/forge.mjs",
  ]) {
    assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
  }

  const gate = read("scripts/check-bytecode-size.mjs");
  assert.match(gate, /EIP170_MAX|24_576/);
  assert.match(gate, /softMax|SOFT_HEADROOM/);
  assert.match(gate, /zQuoter/);
  assert.match(gate, /zRouter/);
});

test("Foundry pin is an installable stable or version tag", () => {
  const pin = read(".foundry-version").trim();
  // Prefer stable/version tags; old nightly digests are pruned from GitHub Releases.
  assert.match(pin, /^(stable|v\d+\.\d+\.\d+)$/);
  assert.match(read(".github/workflows/ci.yml"), /\.foundry-version/);
  assert.match(read(".github/workflows/ci-fork.yml"), /\.foundry-version/);
});

test("CI status checks are documented for branch protection", () => {
  const doc = read("docs/CI.md");
  assert.match(doc, /baseline/);
  assert.match(doc, /Branch protection/);
  assert.match(doc, /Required for merge/);
  assert.match(doc, /Do \*\*not\*\* require `fork`/);
  assert.match(doc, /Neither workflow reads production secrets/);
});

test("README points at CI documentation", () => {
  const readme = read("README.md");
  assert.match(readme, /docs\/CI\.md/);
});
