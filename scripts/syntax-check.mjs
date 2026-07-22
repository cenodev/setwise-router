import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  "scripts/build-zfi-baseline.mjs",
  "scripts/build-zquoter-profile.mjs",
  "scripts/check-bytecode-size.mjs",
  "scripts/test-contracts.mjs",
  "scripts/test-contracts-fork.mjs",
  "scripts/lib/forge.mjs",
  "scripts/syntax-check.mjs",
  "scripts/build-abi-baseline.mjs",
  "scripts/build-abi-docs.mjs",
  "scripts/build-route-fixtures.mjs",
  "scripts/capture-execution-fixtures.mjs",
  "scripts/build-setwise-abi.mjs",
  "scripts/build-setwise-calldata.mjs",
  "scripts/format-check.mjs",
  "scripts/clean.mjs",
  "scripts/build-config.mjs",
  "scripts/verify-deployments.mjs",
  "deployments/constants.mjs",
  "deployments/schema.mjs",
  "deployments/registry.mjs",
  "deployments/rpc.mjs",
  "deployments/proxy.mjs",
  "deployments/bytecode.mjs",
  "deployments/verify.mjs",
  "test/deployment-manifests.test.js",
  "test/provenance.test.js",
  "test/abi-baseline.test.js",
  "test/layout.test.js",
  "test/ci.test.js",
  "test/config-registry.test.js",
  "test/capabilities.test.js",
  "test/setwise-pool.test.js",
  "test/native-config.test.js",
  "config/schema.mjs",
  "config/registry.mjs",
  "config/capabilities.mjs",
  "config/generate.mjs",
  "config/index.mjs",
  "config/native.mjs",
  "services/quote/src/index.js",
  "services/quote/src/setwise-authorization.js",
  "services/quote/src/adapter.js",
  "services/quote/src/mock-adapter.js",
  "services/quote/src/registry.js",
  "services/quote/src/runner.js",
  "services/quote/src/schema.js",
  "services/quote/src/setwise-indicative-adapter.js",
  "services/quote/src/setwise-pool-catalog.js",
  "services/quote/src/setwise-quote-normalize.js",
  "services/quote/src/setwise-rfq-client.js",
  "services/quote/src/zfi-abi.js",
  "services/quote/src/zfi-adapter.js",
  "services/quote/test/identity.test.js",
  "services/quote/test/adapters.test.js",
  "services/quote/test/setwise-authorization.test.js",
  "services/quote/test/setwise-indicative.test.js",
  "services/quote/test/zfi-abi.test.js",
  "services/quote/test/zfi-adapter.test.js",
  "app/src/index.js",
  "app/src/chains.js",
  "app/src/constants.js",
  "app/src/native.js",
  "app/src/network.js",
  "app/src/quote-session.js",
  "app/src/robinhood.js",
  "app/src/tokens.js",
  "app/scripts/build.mjs",
  "app/test/chains.test.js",
  "app/test/tokens.test.js",
  "app/test/quote-session.test.js",
  "app/test/network.test.js",
  "app/test/robinhood.test.js",
  "zFi-main/server/index.js",
  "zFi-main/server/quote.js",
  "zFi-main/server/pin.js",
  "zFi-main/dev_server.mjs",
];

let failed = false;
for (const rel of files) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    console.error(`missing: ${rel}`);
    failed = true;
    continue;
  }
  const result = spawnSync(process.execPath, ["--check", abs], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`syntax error: ${rel}`);
    if (result.stderr) process.stderr.write(result.stderr);
  } else {
    console.log(`ok ${rel}`);
  }
}

if (failed) process.exit(1);
