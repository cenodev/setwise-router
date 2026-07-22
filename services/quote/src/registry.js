/**
 * Quote-source adapter registry (issue #18).
 *
 * A small pluggable collection of adapters keyed by their stable source id.
 * The runner accepts either a registry or a plain array; the registry exists
 * so sources can be registered/looked up by id and duplicate ids are rejected
 * up front rather than surfacing as ambiguous route outcomes.
 */

export class QuoteSourceRegistry {
  /** @param {Iterable<import("./adapter.js").QuoteSourceAdapter>} [adapters] */
  constructor(adapters = []) {
    /** @type {Map<string, import("./adapter.js").QuoteSourceAdapter>} */
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  /**
   * Register an adapter. Throws on a missing id or a duplicate id.
   * @param {import("./adapter.js").QuoteSourceAdapter} adapter
   * @returns {this}
   */
  register(adapter) {
    if (!adapter || typeof adapter.id !== "string" || adapter.id.length === 0) {
      throw new Error("adapter requires a non-empty id");
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`duplicate source id "${adapter.id}"`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  /**
   * @param {string} id
   * @returns {import("./adapter.js").QuoteSourceAdapter|null}
   */
  get(id) {
    return this.adapters.get(id) ?? null;
  }

  /** @returns {import("./adapter.js").QuoteSourceAdapter[]} */
  list() {
    return [...this.adapters.values()];
  }

  [Symbol.iterator]() {
    return this.adapters.values();
  }
}
