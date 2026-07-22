import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("workspace packages exist with package.json", () => {
  const packages = ["services/quote", "app"];
  for (const pkg of packages) {
    const pkgJson = join(root, pkg, "package.json");
    assert.ok(existsSync(pkgJson), `missing ${pkg}/package.json`);
    const parsed = JSON.parse(readFileSync(pkgJson, "utf8"));
    assert.ok(parsed.name, `${pkg}/package.json must have a name`);
    assert.ok(parsed.private === true, `${pkg} must be private`);
  }
});

test("root package.json declares workspaces", () => {
  const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkgJson.workspaces), "workspaces must be an array");
  assert.ok(pkgJson.workspaces.includes("services/quote"));
  assert.ok(pkgJson.workspaces.includes("app"));
});

test("root package.json provides unified commands", () => {
  const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const required = ["build", "test", "lint", "typecheck", "format", "clean"];
  for (const cmd of required) {
    assert.ok(pkgJson.scripts[cmd], `missing root script: ${cmd}`);
  }
});

test("contracts directory has foundry.toml", () => {
  const foundryToml = join(root, "contracts", "foundry.toml");
  assert.ok(existsSync(foundryToml), "contracts/foundry.toml must exist");
  const content = readFileSync(foundryToml, "utf8");
  assert.match(content, /solc_version/);
});

test("tool versions are pinned", () => {
  const toolVersions = join(root, ".tool-versions");
  assert.ok(existsSync(toolVersions), ".tool-versions must exist");
  const content = readFileSync(toolVersions, "utf8");
  assert.match(content, /^node \d+\.\d+\.\d+$/m);

  const nodeVersion = join(root, ".node-version");
  assert.ok(existsSync(nodeVersion), ".node-version must exist");
  const nv = readFileSync(nodeVersion, "utf8").trim();
  assert.match(nv, /^\d+\.\d+\.\d+$/);
});

test("deployments directory exists and is documented", () => {
  assert.ok(existsSync(join(root, "deployments")), "deployments/ must exist");
  assert.ok(
    existsSync(join(root, "deployments", "README.md")),
    "deployments/README.md must exist",
  );
});

test(".env.example exists and .env is git-ignored", () => {
  assert.ok(existsSync(join(root, ".env.example")), ".env.example must exist");
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
});

test("generated artifacts are git-ignored", () => {
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /contracts\/out\//);
  assert.match(gitignore, /contracts\/cache\//);
  assert.match(gitignore, /contracts\/broadcast\//);
  assert.match(gitignore, /contracts\/lib\//);
});

test("engines field pins minimum node version", () => {
  const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkgJson.engines, "engines field required");
  assert.match(pkgJson.engines.node, />=\d+/);
});
