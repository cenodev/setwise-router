/**
 * @typedef {{
 *   chainId: number,
 *   account: string,
 *   quoteId: string,
 *   boundAt: number,
 * }} QuoteBinding
 */

/**
 * @typedef {{
 *   binding: QuoteBinding|null,
 *   invalidated: boolean,
 *   reason: string|null,
 * }} QuoteSession
 */

/** @returns {QuoteSession} */
export function createQuoteSession() {
  return { binding: null, invalidated: false, reason: null };
}

/**
 * Bind an active quote to the current wallet account and chain.
 *
 * @param {QuoteSession} session
 * @param {{ chainId: number, account: string, quoteId: string, boundAt?: number }} input
 */
export function bindQuote(session, input) {
  session.binding = {
    chainId: input.chainId,
    account: input.account.toLowerCase(),
    quoteId: input.quoteId,
    boundAt: input.boundAt ?? Date.now(),
  };
  session.invalidated = false;
  session.reason = null;
  return session;
}

/**
 * @param {QuoteSession} session
 * @param {{ chainId?: number|null, account?: string|null }} wallet
 */
export function isQuoteStale(session, wallet) {
  if (!session.binding || session.invalidated) return true;

  if (wallet.chainId != null && wallet.chainId !== session.binding.chainId) {
    return true;
  }
  if (
    wallet.account != null &&
    wallet.account.toLowerCase() !== session.binding.account
  ) {
    return true;
  }

  return false;
}

/**
 * @param {QuoteSession} session
 * @param {string} reason
 */
export function invalidateQuote(session, reason) {
  session.invalidated = true;
  session.reason = reason;
  session.binding = null;
  return session;
}

/**
 * @param {QuoteSession} session
 * @param {{ chainId?: number|null, account?: string|null }} wallet
 */
export function describeQuoteState(session, wallet) {
  if (session.invalidated) {
    return {
      status: "invalidated",
      message: session.reason ?? "Quote was invalidated.",
    };
  }
  if (!session.binding) {
    return { status: "empty", message: "No active quote." };
  }
  if (isQuoteStale(session, wallet)) {
    if (wallet.chainId != null && wallet.chainId !== session.binding.chainId) {
      return {
        status: "stale",
        message: "Wallet network changed. Request a fresh quote.",
      };
    }
    if (
      wallet.account != null &&
      wallet.account.toLowerCase() !== session.binding.account
    ) {
      return {
        status: "stale",
        message: "Wallet account changed. Request a fresh quote.",
      };
    }
    return { status: "stale", message: "Quote is no longer valid." };
  }
  return { status: "active", message: null };
}

/**
 * @param {QuoteSession} session
 * @param {{ chainId?: number|null, account?: string|null }} wallet
 */
export function canSubmitQuote(session, wallet) {
  const state = describeQuoteState(session, wallet);
  return state.status === "active";
}

/**
 * Invalidate the session when the wallet context changes.
 *
 * @param {QuoteSession} session
 * @param {{ chainId?: number|null, account?: string|null }} wallet
 */
export function syncQuoteSession(session, wallet) {
  if (!session.binding) return session;
  if (isQuoteStale(session, wallet)) {
    if (wallet.chainId != null && wallet.chainId !== session.binding.chainId) {
      invalidateQuote(session, "Wallet network changed.");
    } else if (
      wallet.account != null &&
      wallet.account.toLowerCase() !== session.binding.account
    ) {
      invalidateQuote(session, "Wallet account changed.");
    } else {
      invalidateQuote(session, "Quote is no longer valid.");
    }
  }
  return session;
}
