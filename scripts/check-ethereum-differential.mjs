#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import {
  buildSnapshots,
  compareSnapshots,
  loadDifferentialInputs,
  validateManifest,
} from "./lib/ethereum-differential.mjs";

function reportMarkdown(inputs, result) {
  const rows = result.gas.map(
    (item) =>
      `| ${item.caseId} | ${item.upstream} | ${item.setwise} | ${item.delta} | ${item.deltaBps} |`,
  );
  return [
    "# Ethereum differential report",
    "",
    `- Upstream: \`${inputs.manifest.upstream.commit}\``,
    `- Fork: Ethereum block \`${inputs.manifest.fork.block}\``,
    `- Cases: ${inputs.manifest.cases.length}`,
    `- Allowlisted deviations: ${result.allowlisted}`,
    `- Result: ${result.ok ? "pass" : "fail"}`,
    "",
    "## Gas",
    "",
    "| Case | Upstream | Setwise | Delta | Delta (bps) |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...(rows.length > 0 ? rows : ["| — | — | — | — | — |"]),
    "",
    ...result.warnings.map((warning) => `- Warning: ${warning}`),
    ...result.errors.map((error) => `- Error: ${error}`),
    "",
  ].join("\n");
}

const inputs = loadDifferentialInputs();
const manifestErrors = validateManifest(inputs);
const { upstream, setwise } = buildSnapshots(inputs);
const result = compareSnapshots(
  upstream,
  setwise,
  inputs.allowlist,
  inputs.manifest.gasPolicy,
);
result.errors.unshift(...manifestErrors);
result.ok = result.errors.length === 0;

const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0) {
  const reportPath = process.argv[reportIndex + 1];
  if (!reportPath) throw new Error("--report requires a path");
  writeFileSync(reportPath, reportMarkdown(inputs, result));
}

for (const warning of result.warnings) console.warn(`warning: ${warning}`);
for (const error of result.errors) console.error(`error: ${error}`);
console.log(
  `Ethereum differential: ${result.ok ? "PASS" : "FAIL"} ` +
    `(${inputs.manifest.cases.length} cases, ${result.allowlisted} allowlisted, ${result.gas.length} gas samples)`,
);
process.exit(result.ok ? 0 : 1);
