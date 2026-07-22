import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abiDir = join(root, "baseline", "abi");
const docsDir = join(root, "docs", "baseline");

const router = JSON.parse(readFileSync(join(abiDir, "zRouter.json"), "utf8"));
const quoter = JSON.parse(readFileSync(join(abiDir, "zQuoter.json"), "utf8"));
const matrix = JSON.parse(readFileSync(join(abiDir, "compatibility-matrix.json"), "utf8"));

// Analysis of where each zRouter custom error is raised (zFi-main/src/zRouter.sol).
const ERROR_TRIGGERS = {
  "BadSwap()": "Zero resolved input on exact-in swaps; V3 callback with both pool deltas zero; invalid Curve swap_type/pool_type; a Curve hop that fails to increase the output balance.",
  "Expired()": "checkDeadline modifier: block.timestamp > deadline (swapV2/V3/V4/VZ/Curve).",
  "Slippage()": "Realized output below amountLimit (exact-in) or required input above amountLimit (exact-out) on V2/V3/V4/Curve.",
  "InvalidId()": "deposit: native deposit carrying a non-zero ERC-6909 id.",
  "Unauthorized()": "V3 callback caller is not the computed pool; V4 unlockCallback caller is not the PoolManager; non-owner calling ensureAllowance/trust/transferOwnership; execute() target not whitelisted via trust().",
  "InvalidMsgVal()": "msg.value mismatch on ETH-input Curve swaps and deposit().",
  "SwapExactInFail()": "swapVZ: low-level exact-in call to ZAMM/ZAMM_0 returned false.",
  "SwapExactOutFail()": "swapVZ: low-level exact-out call to ZAMM/ZAMM_0 returned false.",
  "ETHTransferFailed()": "A native ETH transfer (payout or refund) failed.",
  "SnwapSlippage(address,uint256,uint256)": "snwap/snwapMulti: measured recipient balance delta below amountOutMin.",
};

const QUOTER_ERROR_TRIGGERS = {
  "NoRoute()": "No venue produced a non-zero quote, tokenIn == tokenOut, an unbuildable Curve source was selected, or every 2-hop/3-hop/split cascade failed.",
  "SlippageBpsTooHigh()": "slippageBps >= 10000 (100%) passed to a slippage-limit computation.",
};

function fnTable(fns, columns) {
  const header = `| ${columns.map((c) => c.label).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = fns.map((fn) => `| ${columns.map((c) => c.get(fn)).join(" | ")} |`);
  return [header, sep, ...rows].join("\n");
}

const code = (s) => `\`${s}\``;
// Escape pipes so plain-text cell values cannot break GFM table boundaries.
// Values wrapped by code() are inline code spans, where GFM already treats
// pipes literally, so they do not need escaping.
const esc = (s) => String(s ?? "—").replace(/\|/g, "\\|");

function routerSection(title, scope, groupFilter) {
  const fns = router.abi.functions.filter(
    (f) => f.scope === scope && (!groupFilter || groupFilter.includes(f.group)),
  );
  if (fns.length === 0) return "";
  const table = fnTable(fns, [
    { label: "Selector", get: (f) => code(f.selector) },
    { label: "Signature", get: (f) => code(f.signature) },
    { label: "Mutability", get: (f) => f.stateMutability },
    { label: "Venue", get: (f) => esc(f.venue) },
    { label: "Notes", get: (f) => esc(f.notes) },
  ]);
  return `### ${title}\n\n${table}\n`;
}

const routerSwap = routerSection("Swap execution core (scope: core-swap)", "core-swap", ["swap"]);
const routerNative = routerSection("Native / wrapped-native + Lido (scope: swap-support)", "swap-support", ["native"]);
const routerFunding = routerSection("Funding & approvals (scope: swap-support)", "swap-support", ["funding"]);
const routerPlumbing = routerSection("Execution plumbing (scope: swap-support)", "swap-support", ["plumbing"]);
const routerExtension = routerSection("Non-swap extensions (scope: extension)", "extension");

const routerErrors = fnTable(
  [...router.abi.errors].sort((a, b) => a.name.localeCompare(b.name)),
  [
    { label: "Selector", get: (e) => code(e.selector ?? "?") },
    { label: "Error", get: (e) => code(e.signature) },
    { label: "Raised when", get: (e) => esc(ERROR_TRIGGERS[e.signature]) },
  ],
);

const quoterTable = fnTable(quoter.abi.functions, [
  { label: "Selector", get: (f) => code(f.selector) },
  { label: "Signature", get: (f) => code(f.signature) },
  { label: "Role", get: (f) => esc(f.notes) },
]);

const quoterErrors = fnTable(
  [...quoter.abi.errors].sort((a, b) => a.name.localeCompare(b.name)),
  [
    { label: "Selector", get: (e) => code(e.selector ?? "?") },
    { label: "Error", get: (e) => code(e.signature) },
    { label: "Raised when", get: (e) => esc(QUOTER_ERROR_TRIGGERS[e.signature]) },
  ],
);

const venueTable = fnTable(matrix.venues, [
  { label: "ID", get: (v) => (v.id === null ? "—" : String(v.id)) },
  { label: "Venue", get: (v) => v.name },
  { label: "Router function(s)", get: (v) => code(v.routerFunction) },
  { label: "Quoter source", get: (v) => esc(v.quoterSource) },
  { label: "Notes", get: (v) => esc(`${v.notes ?? ""}${v.ethereumOnly ? " (Ethereum-only)" : ""}`) },
]);

const routeTable = fnTable(matrix.routeShapes, [
  { label: "Shape", get: (r) => r.name },
  { label: "Quoter function", get: (r) => code(r.quoterFunction) },
  { label: "Max hops", get: (r) => String(r.hops) },
  { label: "Notes", get: (r) => esc(r.notes) },
]);

const routerEventTable = fnTable(router.abi.events, [
  { label: "Topic hash", get: (e) => code(e.topicHash ?? "?") },
  { label: "Event", get: (e) => code(e.signature) },
]);

const ext = matrix.extensionDecision;
const nonSwap = ext.nonSwapExtensions;
const separate = ext.separateContracts
  .map((c) => `| ${c.name} | \`${c.path}\` | ${c.decision} | ${c.rationale} |`)
  .join("\n");
const knownUnsupported = ext.knownUnsupported.map((k) => `- ${k}`).join("\n");
const ethOnly = matrix.contracts.zRouter.scope.ethereumOnly.map(code).join(", ");

const md = `# ZFi Ethereum ABI compatibility baseline

Pinned to [\`z-fi/zFi@${matrix.upstream.commit}\`](${matrix.upstream.repository}/commit/${matrix.upstream.commit})
via the [\`zFi-main/\`](../../zFi-main) submodule. This document is generated from
the committed fixtures in [\`baseline/abi/\`](../../baseline/abi) — do not edit the
tables by hand.

## Purpose

Issue #5 defines what "preserve ZFi functionality" means on Ethereum. It records
the public router and quoter ABI, the supported venue and route combinations, the
revert surface, and an explicit decision on which non-swap extensions stay in
scope. The fixtures double as a golden baseline: \`test/abi-baseline.test.js\`
fails if the pinned submodule's ABI or the recorded fixtures change unexpectedly.

## Regenerate

\`\`\`bash
npm run build                          # forge build of the pinned zFi-main snapshot
node scripts/build-abi-baseline.mjs    # rewrite baseline/abi/*.json from artifacts
node scripts/build-abi-docs.mjs        # rewrite this document from the fixtures
\`\`\`

## zRouter — public ABI (${router.abi.functions.length} functions)

Deployed bytecode: **${router.deployedBytecodeSize} bytes** (default Foundry
profile; under the EIP-170 limit of 24,576).

${routerSwap}
${routerNative}
${routerFunding}
${routerPlumbing}
${routerExtension}
### Events

${routerEventTable}

### Errors (revert surface)

${routerErrors}

The router also surfaces Solady-style transfer helpers that revert with
\`TransferFailed()\`, \`TransferFromFailed()\`, and \`ApproveFailed()\` from the
free \`safeTransfer\`/\`safeTransferFrom\`/\`safeApprove\` functions.

## zQuoter — public ABI (${quoter.abi.functions.length} functions, all \`view\`)

Deployed bytecode: **${quoter.deployedBytecodeSize} bytes** on the default
profile — this **exceeds EIP-170**. Deploy zQuoter with the \`zquoter\` Foundry
profile (\`optimizer_runs = 20\`, \`yul = false\`) to stay under 24,576 bytes. The
ABI is identical across profiles; only bytecode size differs.

${quoterTable}

### Errors

${quoterErrors}

## Venues and route combinations

${venueTable}

Route discovery shapes (zQuoter):

${routeTable}

Two-hop and three-hop routes intermediate through these hubs: ${matrix.hubs.map(code).join(", ")}.

## Non-swap extension scope decision

${ext.summary}

| Extension | Functions | Decision | Rationale |
| --- | --- | --- | --- |
| NameNFT | ${nonSwap.NameNFT.functions.map(code).join(", ")} | ${nonSwap.NameNFT.decision} | ${nonSwap.NameNFT.rationale} |
| zAMM liquidity | ${nonSwap.zAMM_liquidity.functions.map(code).join(", ")} | ${nonSwap.zAMM_liquidity.decision} | ${nonSwap.zAMM_liquidity.rationale} |
| Ownership | ${nonSwap.ownership.functions.map(code).join(", ")} | ${nonSwap.ownership.decision} | ${nonSwap.ownership.rationale} |

Separate ZFi products that are **not** part of the router/quoter ABI and stay out
of routing scope:

| Component | Upstream path | Decision | Rationale |
| --- | --- | --- | --- |
${separate}

Ethereum-only behavior flagged for capability gating (issue #11): ${ethOnly}.

## Known broken or intentionally unsupported

${knownUnsupported}
`;

mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, "ABI_COMPATIBILITY.md"), md);
console.log("wrote docs/baseline/ABI_COMPATIBILITY.md");
