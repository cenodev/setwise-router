import assert from "node:assert/strict";
import test from "node:test";

import {
  bindQuote,
  canSubmitQuote,
  createQuoteSession,
  describeQuoteState,
  invalidateQuote,
  isQuoteStale,
  syncQuoteSession,
} from "../src/quote-session.js";

test("quotes invalidate when wallet chain changes", () => {
  const session = createQuoteSession();
  bindQuote(session, {
    chainId: 1,
    account: "0xAbC00000000000000000000000000000000000001",
    quoteId: "q-1",
  });

  assert.equal(isQuoteStale(session, { chainId: 8453, account: session.binding.account }), true);
  const account = session.binding.account;
  syncQuoteSession(session, { chainId: 8453, account });
  assert.equal(session.invalidated, true);
  assert.match(session.reason ?? "", /network changed/i);
});

test("quotes invalidate when wallet account changes", () => {
  const session = createQuoteSession();
  bindQuote(session, {
    chainId: 56,
    account: "0xAbC00000000000000000000000000000000000001",
    quoteId: "q-2",
  });

  assert.equal(
    isQuoteStale(session, {
      chainId: 56,
      account: "0xAbC00000000000000000000000000000000000002",
    }),
    true,
  );
});

test("active quotes can be submitted only while wallet context matches", () => {
  const session = createQuoteSession();
  bindQuote(session, {
    chainId: 8453,
    account: "0xAbC00000000000000000000000000000000000003",
    quoteId: "q-3",
  });

  const wallet = {
    chainId: 8453,
    account: "0xAbC00000000000000000000000000000000000003",
  };

  assert.equal(canSubmitQuote(session, wallet), true);
  assert.equal(describeQuoteState(session, wallet).status, "active");

  invalidateQuote(session, "Manual refresh.");
  assert.equal(canSubmitQuote(session, wallet), false);
  assert.equal(describeQuoteState(session, wallet).status, "invalidated");
});
