/**
 * Indicative-to-firm selection and fail-closed execution workflow (issue #23).
 *
 * Set firming is gated by the indicative comparison. Current firm competitors
 * are then re-ranked with the short-lived Set quote, and only a complete router
 * transaction that simulates at the current block may become executable.
 */

import { generateCorrelationId } from "./correlation.js";
import { rankQuoteSources } from "./ranking.js";
import { assembleQuoteResponse } from "./response.js";
import { runQuoteSources } from "./runner.js";
import { validateQuoteRequest } from "./schema.js";

/** Minimum lifetime left after firming for wallet signing and submission. */
export const DEFAULT_WALLET_SUBMISSION_BUFFER_MS = 15_000;

function uniqueAdapters(adapters) {
  const seen = new Set();
  return adapters.filter((adapter) => {
    if (seen.has(adapter.id)) return false;
    seen.add(adapter.id);
    return true;
  });
}

function reason(sourceId, stage, code, message, observedAt) {
  return { sourceId, stage, code, message, observedAt };
}

function evidenceReason(outcome, stage, observedAt) {
  const evidence = outcome.evidence?.find((entry) => entry.code);
  return reason(
    outcome.source.id,
    stage,
    evidence?.code ?? "FIRM_QUOTE_UNAVAILABLE",
    evidence?.message ?? `${outcome.source.displayName} firm quote is unavailable`,
    observedAt,
  );
}

function failOutcome(outcome, code, message, observedAt) {
  const { ranking: _ranking, ...unranked } = outcome;
  return {
    ...unranked,
    status: "failed",
    quote: null,
    evidence: [
      ...outcome.evidence,
      {
        kind: code === "SIMULATION_FAILED" ? "simulation" : "policy",
        observedAt,
        reference: `firm-selection:${outcome.source.id}`,
        code,
        message,
      },
    ],
  };
}

function validateFirmTransaction(transaction, request) {
  if (!transaction || typeof transaction !== "object") {
    return ["FIRM_TRANSACTION_MISSING", "firm source did not return a transaction"];
  }
  if (
    transaction.chainId !== request.chainId ||
    typeof transaction.to !== "string" ||
    transaction.to.toLowerCase() !== request.router.address.toLowerCase()
  ) {
    return [
      "FIRM_TRANSACTION_INVALID",
      "firm transaction is not bound to the requested chain and router",
    ];
  }
  if (
    typeof transaction.calldata !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.calldata) ||
    typeof transaction.value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(transaction.value)
  ) {
    return [
      "FIRM_TRANSACTION_INVALID",
      "firm transaction calldata or value is malformed",
    ];
  }
  return null;
}

function expiryFailure(outcome, nowMs, bufferMs) {
  const expiry = Date.parse(outcome.quote?.expiresAt);
  if (!Number.isFinite(expiry)) {
    return ["FIRM_EXPIRY_INVALID", "firm quote has no valid expiry"];
  }
  if (expiry - nowMs < bufferMs) {
    return [
      "FIRM_EXPIRY_TOO_SOON",
      `firm quote leaves less than ${bufferMs}ms for wallet submission`,
    ];
  }
  return null;
}

function simulatorMethod(simulator) {
  if (typeof simulator === "function") return simulator;
  if (typeof simulator?.simulateTransaction === "function") {
    return simulator.simulateTransaction.bind(simulator);
  }
  if (typeof simulator?.simulate === "function") {
    return simulator.simulate.bind(simulator);
  }
  return null;
}

function simulationResult(result) {
  if (result === true || result?.success === true) {
    return {
      success: true,
      blockNumber: result?.blockNumber,
      message: result?.message ?? "router transaction simulation succeeded",
    };
  }
  return {
    success: false,
    code: result?.code ?? "SIMULATION_FAILED",
    message: result?.message ?? "router transaction simulation failed",
  };
}

/**
 * Compare indicative quotes, firm Set only if it wins, re-rank current firm
 * competitors, and simulate the best complete router transaction. Failures are
 * removed before re-ranking so a failed simulation can never remain selected.
 *
 * @param {Iterable<import("./adapter.js").QuoteSourceAdapter>} adapters
 * @param {object} request
 * @param {object} [options]
 * @param {object|Function} [options.simulator]
 * @param {number} [options.submissionBufferMs]
 * @param {AbortSignal} [options.signal]
 * @param {() => string} [options.now]
 * @param {string} [options.requestId]
 * @param {object} [options.ranking]
 */
export async function runSetwiseFirmSelection(adapters, request, options = {}) {
  const validated = validateQuoteRequest(request);
  const now = options.now ?? (() => new Date().toISOString());
  const requestId = options.requestId ?? generateCorrelationId();
  const ranking = options.ranking ?? {};
  const all = [...adapters];
  const indicativeAdapters = uniqueAdapters(
    all.filter((adapter) =>
      adapter.supports(validated.chainId, validated.mode, "indicative"),
    ),
  );
  if (indicativeAdapters.length === 0) {
    throw new Error("indicative-to-firm selection requires an indicative source");
  }

  const indicativeRun = await runQuoteSources(indicativeAdapters, validated, {
    kind: "indicative",
    signal: options.signal,
    now,
  });
  const indicativeResponse = assembleQuoteResponse({
    request: validated,
    sources: indicativeRun.sources,
    kind: "indicative",
    requestId,
    ranking,
  });
  const indicativeWinner = indicativeResponse.sources.find(
    (outcome) => outcome.source.id === indicativeResponse.selectedSourceId,
  );
  const setWon = indicativeWinner?.source.type === "setwise";
  const fallbacks = [];

  const supportedFirm = all.filter((adapter) =>
    adapter.supports(validated.chainId, validated.mode, "firm"),
  );
  const firmAdapters = uniqueAdapters(
    supportedFirm.filter(
      (adapter) =>
        adapter.type !== "setwise" ||
        (setWon && adapter.id === indicativeResponse.selectedSourceId),
    ),
  );
  for (const setAdapter of supportedFirm.filter(
    (adapter) => adapter.type === "setwise" && !firmAdapters.includes(adapter),
  )) {
    fallbacks.push(
      reason(
        setAdapter.id,
        "indicative",
        "SET_NOT_COMPETITIVE",
        "Set was not the winning indicative source, so no firm quote was requested",
        now(),
      ),
    );
  }
  if (
    setWon &&
    !firmAdapters.some(
      (adapter) =>
        adapter.type === "setwise" &&
        adapter.id === indicativeResponse.selectedSourceId,
    )
  ) {
    fallbacks.push(
      reason(
        indicativeResponse.selectedSourceId,
        "firming",
        "FIRM_ADAPTER_UNAVAILABLE",
        "winning Set indication has no matching firm adapter",
        now(),
      ),
    );
  }
  if (firmAdapters.length === 0) {
    return {
      response: indicativeResponse,
      indicativeResponse,
      indicativeSources: indicativeRun.sources,
      firmSources: [],
      timings: { indicative: indicativeRun.timings, firm: [] },
      fallbacks,
    };
  }

  const firmRun = await runQuoteSources(firmAdapters, validated, {
    kind: "firm",
    signal: options.signal,
    now,
  });
  let firmSources = firmRun.sources;
  const transactions = { ...firmRun.transactions };
  for (const outcome of firmSources) {
    if (outcome.status !== "available") {
      fallbacks.push(evidenceReason(outcome, "firming", now()));
    }
  }

  const submissionBufferMs =
    options.submissionBufferMs ?? DEFAULT_WALLET_SUBMISSION_BUFFER_MS;
  firmSources = firmSources.map((outcome) => {
    if (outcome.status !== "available") return outcome;
    const invalidTransaction = validateFirmTransaction(
      transactions[outcome.source.id],
      validated,
    );
    const invalidExpiry = expiryFailure(
      outcome,
      Date.parse(now()),
      submissionBufferMs,
    );
    const failure = invalidTransaction ?? invalidExpiry;
    if (!failure) return outcome;
    const [code, message] = failure;
    delete transactions[outcome.source.id];
    fallbacks.push(reason(outcome.source.id, "preflight", code, message, now()));
    return failOutcome(outcome, code, message, now());
  });

  const simulate = simulatorMethod(options.simulator);
  while (true) {
    const selectedId = rankQuoteSources(firmSources, validated, ranking).selectedSourceId;
    if (!selectedId) {
      return {
        response: indicativeResponse,
        indicativeResponse,
        indicativeSources: indicativeRun.sources,
        firmSources,
        timings: { indicative: indicativeRun.timings, firm: firmRun.timings },
        fallbacks,
      };
    }
    const selectedIndex = firmSources.findIndex(
      (outcome) => outcome.source.id === selectedId,
    );
    const selected = firmSources[selectedIndex];
    const beforeSimulation = expiryFailure(
      selected,
      Date.parse(now()),
      submissionBufferMs,
    );
    if (beforeSimulation) {
      const [code, message] = beforeSimulation;
      firmSources[selectedIndex] = failOutcome(selected, code, message, now());
      delete transactions[selectedId];
      fallbacks.push(reason(selectedId, "preflight", code, message, now()));
      continue;
    }
    if (!simulate) {
      const code = "SIMULATOR_UNAVAILABLE";
      const message = "firm execution is disabled because no simulator is configured";
      firmSources[selectedIndex] = failOutcome(selected, code, message, now());
      delete transactions[selectedId];
      fallbacks.push(reason(selectedId, "simulation", code, message, now()));
      continue;
    }

    let simulated;
    try {
      simulated = simulationResult(
        await simulate(transactions[selectedId], {
          request: validated,
          source: selected.source,
          blockTag: "latest",
          signal: options.signal,
        }),
      );
    } catch (error) {
      simulated = {
        success: false,
        code: error?.code ?? "SIMULATION_FAILED",
        message: error?.message ?? "router transaction simulation failed",
      };
    }
    if (!simulated.success) {
      firmSources[selectedIndex] = failOutcome(
        selected,
        simulated.code,
        simulated.message,
        now(),
      );
      delete transactions[selectedId];
      fallbacks.push(
        reason(
          selectedId,
          "simulation",
          simulated.code,
          simulated.message,
          now(),
        ),
      );
      continue;
    }

    const afterSimulation = expiryFailure(
      selected,
      Date.parse(now()),
      submissionBufferMs,
    );
    if (afterSimulation) {
      const code = "FIRM_EXPIRED_DURING_SIMULATION";
      const message = "firm quote no longer leaves enough time after simulation";
      firmSources[selectedIndex] = failOutcome(selected, code, message, now());
      delete transactions[selectedId];
      fallbacks.push(reason(selectedId, "simulation", code, message, now()));
      continue;
    }
    firmSources[selectedIndex] = {
      ...selected,
      evidence: [
        ...selected.evidence,
        {
          kind: "simulation",
          observedAt: now(),
          reference: `simulation:${selectedId}:latest`,
          ...(simulated.blockNumber === undefined
            ? {}
            : { blockNumber: String(simulated.blockNumber) }),
          code: "SIMULATION_SUCCEEDED",
          message: simulated.message,
        },
      ],
    };
    const response = assembleQuoteResponse({
      request: validated,
      sources: firmSources,
      kind: "firm",
      requestId,
      transactions,
      ranking,
    });
    return {
      response,
      indicativeResponse,
      indicativeSources: indicativeRun.sources,
      firmSources,
      timings: { indicative: indicativeRun.timings, firm: firmRun.timings },
      fallbacks,
    };
  }
}
