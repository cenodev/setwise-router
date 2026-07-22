import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const provenancePath = join(root, "docs/upstream/PROVENANCE.json");

function loadProvenance() {
  return JSON.parse(readFileSync(provenancePath, "utf8"));
}

function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("PROVENANCE.json records the exact upstream URL and commit", () => {
  const provenance = loadProvenance();
  assert.equal(provenance.upstream.repository, "https://github.com/z-fi/zFi");
  assert.match(provenance.upstream.commit, /^[0-9a-f]{40}$/);
  assert.equal(
    provenance.upstream.commitUrl,
    `https://github.com/z-fi/zFi/commit/${provenance.upstream.commit}`,
  );
  assert.equal(provenance.upstream.license, "MIT");
  assert.match(provenance.upstream.copyright, /2026 ZAMM/);
  assert.equal(provenance.localPath, "zFi-main");
  assert.equal(provenance.submodule.commit, provenance.upstream.commit);
});

test("zFi-main submodule is checked out at the pinned commit", () => {
  const provenance = loadProvenance();
  const zfi = join(root, "zFi-main");
  assert.ok(existsSync(join(zfi, ".git")) || existsSync(join(root, ".git")), "git metadata present");
  const head = git(["rev-parse", "HEAD"], zfi);
  assert.equal(head, provenance.upstream.commit);
  const superprojectSha = git(["rev-parse", "HEAD:zFi-main"]);
  assert.equal(superprojectSha, provenance.upstream.commit);
});

test("required ZFi source layers are present", () => {
  const provenance = loadProvenance();
  for (const rel of provenance.requiredLayers) {
    const abs = join(root, rel);
    assert.ok(existsSync(abs), `missing required layer: ${rel}`);
  }

  // Routing modules expected by the import scope
  for (const mod of ["aggregators.js", "send.js"]) {
    assert.ok(
      existsSync(join(root, "zFi-main/dapp/modules", mod)),
      `missing dapp routing module: ${mod}`,
    );
  }

  assert.ok(existsSync(join(root, "zFi-main/audit/zRouter/cantina.md")));
  assert.ok(existsSync(join(root, "zFi-main/audit/zRouter/zellic.md")));
  assert.ok(existsSync(join(root, "zFi-main/server/package.json")));
});

test("MIT license and copyright notices are visible at root and upstream", () => {
  const rootLicense = readFileSync(join(root, "LICENSE"), "utf8");
  const upstreamLicense = readFileSync(join(root, "zFi-main/LICENSE"), "utf8");
  const notice = readFileSync(join(root, "NOTICE"), "utf8");

  for (const text of [rootLicense, upstreamLicense]) {
    assert.match(text, /MIT License/);
    assert.match(text, /Copyright \(c\) 2026 ZAMM/);
  }
  assert.match(notice, /43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3/);
  assert.match(notice, /https:\/\/github\.com\/z-fi\/zFi/);
  assert.ok(existsSync(join(root, "docs/upstream/PROVENANCE.md")));
  assert.ok(existsSync(join(root, "docs/upstream/FORK_MAP.md")));
});

test("forge-std nested dependency matches the recorded pin when present", () => {
  const provenance = loadProvenance();
  const forgeStd = join(root, "zFi-main/lib/forge-std");
  if (!existsSync(join(forgeStd, "src"))) {
    assert.fail(
      "forge-std is missing; run: git submodule update --init --recursive",
    );
  }
  const head = git(["rev-parse", "HEAD"], forgeStd);
  assert.equal(head, provenance.nestedDependencies[0].commit);
});
