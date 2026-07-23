import assert from "node:assert/strict";
import test from "node:test";

import { QuoteSourceAdapter } from "../src/adapter.js";
import {
  DEFAULT_WALLET_SUBMISSION_BUFFER_MS,
  runSetwiseFirmSelection,
} from "../src/setwise-firm-selection.js";

const address = (suffix) => `0x${suffix.padStart(40, "0")}`;
const scoped = (chainId, suffix) => ({ chainId, address: address(suffix) });
const START = Date.parse("2026-07-23T12:00:00.000Z");

function request(overrides = {}) {
  return {
    apiVersion: "v1",
    chainId: 8453,
    tokenIn: scoped(8453, "11"),
    tokenOut: scoped(8453, "22"),
    router: scoped(8453, "33"),
    mode: "exact-input",
    amount: "1000000",
    recipient: scoped(8453, "44"),
    funder: scoped(8453, "55"),
    slippage: { maxBps: 50 },
    ...overrides,
  };
}

function descriptor(id, setwise = false) {
  return setwise
    ? { id, type: "setwise", displayName: "Set", poolId: id.slice(4) }
    : { id, type: "aggregator", displayName: id };
}

class StageAdapter extends QuoteSourceAdapter {
  constructor(id, kind, behavior = {}, setwise = false) {
    super(descriptor(id, setwise), {
      capabilities: {
        chains: [8453],
        modes: ["exact-input", "exact-output"],
        kinds: [kind],
      },
    });
    this.behavior = behavior;
    this.calls = 0;
  }

  async quote(req, context) {
    this.calls += 1;
    if (this.behavior.onQuote) await this.behavior.onQuote(req, context);
    const observedAt = context.now();
    if (this.behavior.status && this.behavior.status !== "available") {
      return {
        status: this.behavior.status,
        quote: null,
        evidence: [
          {
            kind: "http",
            observedAt,
            reference: `${this.id}:${context.kind}`,
            code: this.behavior.code,
            message: this.behavior.message ?? this.behavior.code,
          },
        ],
      };
    }
    const firm = context.kind === "firm";
    const quote = {
      kind: context.kind,
      amounts: {
        input:
          req.mode === "exact-input"
            ? req.amount
            : this.behavior.input ?? "1000000",
        output:
          req.mode === "exact-output"
            ? req.amount
            : this.behavior.output ?? "2500000",
        limit: this.behavior.limit ?? "2480000",
      },
      gas: { estimatedUnits: "0", estimatedCost: "0" },
      fees: [],
      approvalTarget: firm
        ? this.behavior.approvalTarget ?? req.router
        : null,
      expiresAt: firm
        ? this.behavior.expiresAt ??
          new Date(Date.parse(observedAt) + 60_000).toISOString()
        : null,
    };
    return {
      status: "available",
      quote,
      evidence: [
        {
          kind: this.type === "aggregator" ? "http" : "onchain",
          observedAt,
          reference: `${this.id}:${context.kind}`,
          code: "AVAILABLE",
        },
      ],
      ...(firm
        ? {
            transaction: {
              chainId: req.chainId,
              to: this.behavior.transactionTo ?? req.router.address,
              calldata: this.behavior.calldata ?? "0x1234",
              value: "0",
            },
          }
        : {}),
    };
  }
}

function workflowAdapters(overrides = {}) {
  return {
    setIndicative: new StageAdapter(
      "set-bstock-ai",
      "indicative",
      { output: "2600000", ...overrides.setIndicative },
      true,
    ),
    setFirm: new StageAdapter(
      "set-bstock-ai",
      "firm",
      { output: "2550000", ...overrides.setFirm },
      true,
    ),
    competitorIndicative: new StageAdapter(
      "competitor",
      "indicative",
      { output: "2500000", ...overrides.competitorIndicative },
    ),
    competitorFirm: new StageAdapter(
      "competitor",
      "firm",
      { output: "2520000", ...overrides.competitorFirm },
    ),
  };
}

function list(group) {
  return [
    group.setIndicative,
    group.setFirm,
    group.competitorIndicative,
    group.competitorFirm,
  ];
}

test("firms competitive Set, re-ranks firm amounts, and simulates at latest", async () => {
  const adapters = workflowAdapters();
  const simulations = [];
  const result = await runSetwiseFirmSelection(list(adapters), request(), {
    now: () => new Date(START).toISOString(),
    simulator: async (transaction, context) => {
      simulations.push({ transaction, context });
      return { success: true, blockNumber: "123456" };
    },
  });

  assert.equal(result.indicativeResponse.kind, "indicative");
  assert.equal(result.indicativeResponse.transaction, null);
  assert.equal(result.indicativeResponse.selectedSourceId, "set-bstock-ai");
  assert.equal(adapters.setFirm.calls, 1);
  assert.equal(result.response.kind, "firm");
  assert.equal(result.response.selectedSourceId, "set-bstock-ai");
  assert.equal(result.response.transaction.calldata, "0x1234");
  assert.equal(simulations.length, 1);
  assert.equal(simulations[0].context.blockTag, "latest");
  assert.equal(simulations[0].context.source.displayName, "Set");
});

test("does not request a Set firm quote when Set loses indicative comparison", async () => {
  const adapters = workflowAdapters({
    setIndicative: { output: "2400000" },
  });
  const result = await runSetwiseFirmSelection(list(adapters), request(), {
    now: () => new Date(START).toISOString(),
    simulator: async () => true,
  });

  assert.equal(adapters.setFirm.calls, 0);
  assert.equal(result.response.selectedSourceId, "competitor");
  assert.ok(
    result.fallbacks.some((entry) => entry.code === "SET_NOT_COMPETITIVE"),
  );
});

test("falls back from signer, inventory, and stale Set firm failures", async (t) => {
  const cases = [
    ["SIGNER_UNAVAILABLE", "signer unavailable"],
    ["INSUFFICIENT_INVENTORY", "inventory unavailable"],
    ["FIRM_QUOTE_STALE", "firm quote stale"],
  ];
  for (const [code, message] of cases) {
    await t.test(code, async () => {
      const adapters = workflowAdapters({
        setFirm: { status: "unavailable", code, message },
      });
      const result = await runSetwiseFirmSelection(list(adapters), request(), {
        now: () => new Date(START).toISOString(),
        simulator: async () => true,
      });
      assert.equal(result.response.selectedSourceId, "competitor");
      assert.ok(
        result.fallbacks.some(
          (entry) =>
            entry.sourceId === "set-bstock-ai" &&
            entry.stage === "firming" &&
            entry.code === code,
        ),
      );
    });
  }
});

test("failed Set simulation re-ranks and uses competitor approval and transaction", async () => {
  const competitorApproval = scoped(8453, "77");
  const adapters = workflowAdapters({
    setFirm: { output: "2700000", calldata: "0xaaaa" },
    competitorFirm: {
      output: "2500000",
      calldata: "0xbbbb",
      approvalTarget: competitorApproval,
    },
  });
  const result = await runSetwiseFirmSelection(list(adapters), request(), {
    now: () => new Date(START).toISOString(),
    simulator: async (_transaction, { source }) =>
      source.id === "set-bstock-ai"
        ? { success: false, code: "SIMULATION_FAILED", message: "revert" }
        : { success: true, blockNumber: "123457" },
  });

  assert.equal(result.response.selectedSourceId, "competitor");
  assert.equal(result.response.transaction.calldata, "0xbbbb");
  const selected = result.response.sources.find(
    (outcome) => outcome.source.id === "competitor",
  );
  assert.deepEqual(selected.quote.approvalTarget, competitorApproval);
  const failedSet = result.response.sources.find(
    (outcome) => outcome.source.id === "set-bstock-ai",
  );
  assert.equal(failedSet.status, "failed");
  assert.equal(failedSet.quote, null);
});

test("all failed simulations return the non-executable indicative response", async () => {
  const adapters = workflowAdapters();
  const result = await runSetwiseFirmSelection(list(adapters), request(), {
    now: () => new Date(START).toISOString(),
    simulator: async () => ({ success: false, message: "revert" }),
  });

  assert.equal(result.response.kind, "indicative");
  assert.equal(result.response.transaction, null);
  assert.equal(result.firmSources.every((outcome) => outcome.status === "failed"), true);
  assert.equal(
    result.fallbacks.filter((entry) => entry.code === "SIMULATION_FAILED").length,
    2,
  );
});

test("rejects a firm quote that is too short-lived for wallet submission", async () => {
  const adapters = workflowAdapters({
    setFirm: {
      expiresAt: new Date(
        START + DEFAULT_WALLET_SUBMISSION_BUFFER_MS - 1,
      ).toISOString(),
    },
  });
  const result = await runSetwiseFirmSelection(list(adapters), request(), {
    now: () => new Date(START).toISOString(),
    simulator: async () => true,
  });

  assert.equal(result.response.selectedSourceId, "competitor");
  assert.ok(
    result.fallbacks.some((entry) => entry.code === "FIRM_EXPIRY_TOO_SOON"),
  );
});

test("concurrent workflows keep selection and simulation state isolated", async () => {
  const adapters = workflowAdapters();
  const [first, second] = await Promise.all([
    runSetwiseFirmSelection(list(adapters), request({ amount: "1000000" }), {
      requestId: "req_first",
      now: () => new Date(START).toISOString(),
      simulator: async () => ({ success: true }),
    }),
    runSetwiseFirmSelection(list(adapters), request({ amount: "2000000" }), {
      requestId: "req_second",
      now: () => new Date(START).toISOString(),
      simulator: async () => ({ success: false }),
    }),
  ]);

  assert.equal(first.response.kind, "firm");
  assert.equal(first.response.requestId, "req_first");
  assert.equal(first.response.sources[0].quote.amounts.input, "1000000");
  assert.equal(second.response.kind, "indicative");
  assert.equal(second.response.requestId, "req_second");
  assert.equal(second.response.sources[0].quote.amounts.input, "2000000");
});

test("rechecks expiry after simulation to close stale-state races", async () => {
  let clock = START;
  const adapters = workflowAdapters({
    competitorFirm: { status: "unavailable", code: "NO_LIQUIDITY" },
  });
  const result = await runSetwiseFirmSelection(list(adapters), request(), {
    now: () => new Date(clock).toISOString(),
    simulator: async () => {
      clock += 50_000;
      return { success: true };
    },
  });

  assert.equal(result.response.kind, "indicative");
  assert.equal(result.response.transaction, null);
  assert.ok(
    result.fallbacks.some(
      (entry) => entry.code === "FIRM_EXPIRED_DURING_SIMULATION",
    ),
  );
});

test("missing simulator fails closed without exposing a transaction", async () => {
  const adapters = workflowAdapters();
  const result = await runSetwiseFirmSelection(list(adapters), request(), {
    now: () => new Date(START).toISOString(),
  });
  assert.equal(result.response.kind, "indicative");
  assert.equal(result.response.transaction, null);
  assert.ok(
    result.fallbacks.some((entry) => entry.code === "SIMULATOR_UNAVAILABLE"),
  );
});
