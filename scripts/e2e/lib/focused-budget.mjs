const exhausted = (code) => Object.assign(Error(code), { code });

export class FocusedAcceptanceBudget {
  constructor({ maxTurns = 5, maxGenerations = 10, maxSearchRequests = Infinity } = {}) {
    this.maxTurns = maxTurns;
    this.maxGenerations = maxGenerations;
    this.maxSearchRequests = maxSearchRequests;
    this.turns = 0;
    this.generations = 0;
    this.generationAttempts = 0;
    this.blockedGenerations = 0;
    this.implicitRetries = 0;
    this.searchRequests = 0;
    this.blockedSearchRequests = 0;
    this.activeAbort = null;
  }

  beginTurn() {
    if (this.turns >= this.maxTurns) throw exhausted("turn_budget_exhausted");
    if (this.generations >= this.maxGenerations)
      throw exhausted("generation_budget_exhausted");
    this.turns++;
  }

  beforeOutbound(event) {
    if (event.path.endsWith("/alpha/search")) {
      if (!event.official) throw exhausted("search_destination_rejected");
      if (this.searchRequests >= this.maxSearchRequests) {
        this.blockedSearchRequests++;
        this.activeAbort?.();
        throw exhausted("search_budget_exhausted");
      }
      this.searchRequests++;
      return;
    }
    // Compressed official requests may not expose a decoded model to the harness.
    // Count every Responses send unless it is positively identified as prewarm.
    if (
      (!event.path.endsWith("/responses") &&
        !event.path.endsWith("/responses/compact")) ||
      event.generate === false
    )
      return;
    this.generationAttempts++;
    if (event.requestFingerprint && this.generationFingerprints?.has(event.requestFingerprint)) {
      this.implicitRetries++;
      this.blockedGenerations++;
      this.activeAbort?.();
      throw exhausted("implicit_model_retry_detected");
    }
    this.generationFingerprints ??= new Set();
    if (event.requestFingerprint)
      this.generationFingerprints.add(event.requestFingerprint);
    if (this.generations >= this.maxGenerations) {
      this.blockedGenerations++;
      this.activeAbort?.();
      throw exhausted("generation_budget_exhausted");
    }
    this.generations++;
  }

  snapshot() {
    return {
      turns: this.turns,
      maxTurns: this.maxTurns,
      generations: this.generations,
      maxGenerations: this.maxGenerations,
      generationAttempts: this.generationAttempts,
      blockedGenerations: this.blockedGenerations,
      implicitRetries: this.implicitRetries,
      searchRequests: this.searchRequests,
      maxSearchRequests: Number.isFinite(this.maxSearchRequests)
        ? this.maxSearchRequests
        : null,
      blockedSearchRequests: this.blockedSearchRequests,
    };
  }
}
