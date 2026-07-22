import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry } from "../config/registry.mjs";
import { generateAll } from "../config/generate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "config", "generated");

const chains = registry();
const { service, app, deploy } = generateAll(chains);

mkdirSync(outDir, { recursive: true });

const outputs = {
  "service-config.json": service,
  "app-config.json": app,
  "deploy-inputs.json": deploy,
};

for (const [file, data] of Object.entries(outputs)) {
  const target = join(outDir, file);
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote config/generated/${file}`);
}

console.log(
  `generated typed config for chains: ${[...chains.keys()].sort((a, b) => a - b).join(", ")}`,
);
