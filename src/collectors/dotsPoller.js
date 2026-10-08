"use strict";

// The one Dots status poller of the plugin, running only while a Dots key is loaded. Each round reads the ChatGPT
// sign-in and the app's local cache, then (status source "auto") asks the backend for the dot list and the recent
// activity of one dot, taking turns. About every 150 s (±10%, longer with more dots), at most 60 requests an hour,
// one round at a time. Failures wait before the next request: network errors back off up to 15 min, 429 waits
// for Retry-After, a 401 before the token's exp 30 min (or until the token changes), an expired token is never
// sent; a 429 or 401 on the activity request waits the same way. While waiting, rounds still re-read the local cache
// every 30 s. The next round has a fixed time: stopping and starting again (a page switch) or an unplugged Flexbar
// never moves it closer, and a restart within 60 s of the last round never runs one at once. Clock and timers are
// injectable.

const { isTokenExpired } = require("./dotsAuth");

const DEFAULT_TIMING = Object.freeze({
  intervalMs: 150_000,
  jitter: 0.1,
  stretchPerDot: 0.25,
  maxStretch: 2,
  localIntervalMs: 30_000,
  budgetPerHour: 60,
  budgetWindowMs: 3_600_000,
  backoffMaxMs: 900_000,
  rejectedWaitMs: 1_800_000,
  noAccessWaitMs: 1_800_000,
  rateLimitDefaultMs: 900_000,
  rateLimitMinMs: 60_000,
  rateLimitMaxMs: 3_600_000,
  minStartGapMs: 60_000,
});
const AUTH_GATES = new Set(["authRejected", "authExpired"]);

/** The poller's public face: start, stop, setPaused, requestRefresh, refreshNow, recordRequest, getState, ... */
function createDotsPoller(options) {
  return new DotsPoller(options);
}

class DotsPoller {
  #deps;
  #timing;
  #status = { running: false, paused: false, inFlight: false, rerun: false };
  #timers = { main: null, extra: new Set() };
  #memory;
  #requests = [];
  #lastEvents = { list: null, activity: null, route: null };
  #state = Object.freeze({ source: "auto", network: null, cache: null, error: null, signedOut: null });

  constructor(options) {
    this.#deps = withDefaults(options);
    this.#timing = { ...DEFAULT_TIMING, ...(options.timing || {}) };
    this.#memory = { lastRoundAt: 0, nextRoundAt: null, rotation: 0, failures: 0, gate: null, budgetLogged: false };
  }

  start() {
    if (this.#status.running) return Promise.resolve();
    this.#status.running = true;
    // A round still in flight plans the next one when it ends.
    if (this.#status.paused || this.#status.inFlight) return Promise.resolve();
    const { lastRoundAt, nextRoundAt } = this.#memory;
    if (nextRoundAt === null || this.#deps.now() - lastRoundAt >= this.#timing.minStartGapMs) return this.#round("start");
    this.#publish();
    this.#scheduleAt(Math.max(nextRoundAt, lastRoundAt + this.#timing.minStartGapMs));
    return Promise.resolve();
  }

  stop() {
    this.#status.running = false;
    this.#status.rerun = false;
    this.#clearAll();
  }

  isRunning() {
    return this.#status.running;
  }

  setPaused(paused) {
    if (Boolean(paused) === this.#status.paused) return Promise.resolve();
    this.#status.paused = Boolean(paused);
    if (this.#status.paused) {
      this.#clearAll();
      return Promise.resolve();
    }
    return this.#status.running ? this.#resume() : Promise.resolve();
  }

  requestRefresh(delays) {
    if (!this.#status.running || this.#status.paused) return;
    for (const delay of delays || []) {
      const id = this.#deps.setTimer(() => {
        this.#timers.extra.delete(id);
        this.#round("refresh");
      }, Math.max(0, Number(delay) || 0));
      this.#timers.extra.add(id);
    }
  }

  refreshNow({ resetGates = false } = {}) {
    const { gate } = this.#memory;
    if (resetGates && gate && gate.reason !== "rateLimited") {
      this.#memory.gate = null;
      this.#memory.failures = 0;
    }
    return this.#status.running && !this.#status.paused ? this.#round("config") : Promise.resolve();
  }

  /** Called by the client for every HTTP attempt: counts toward the budget and feeds the diagnostics. */
  recordRequest(event) {
    this.#requests.push(this.#deps.now());
    if (!event || typeof event !== "object") return;
    const summary = { status: Number.isInteger(event.status) ? event.status : null, category: event.category || null };
    if (event.kind === "activity") this.#lastEvents.activity = summary;
    else this.#lastEvents.list = summary;
    this.#lastEvents.route = typeof event.route === "string" ? event.route : null;
  }

  getState() {
    return this.#state;
  }

  getDiagnostics() {
    const state = this.#state;
    return {
      source: state.source,
      route: this.#lastEvents.route,
      list: this.#lastEvents.list,
      activity: this.#lastEvents.activity,
      dots: state.network ? state.network.dots.length : null,
      error: state.error ? state.error.category : null,
    };
  }

  #patch(changes) {
    this.#state = Object.freeze({ ...this.#state, ...changes });
  }

  #clearMain() {
    if (this.#timers.main !== null) this.#deps.clearTimer(this.#timers.main);
    this.#timers.main = null;
  }

  #clearAll() {
    this.#clearMain();
    for (const id of this.#timers.extra) this.#deps.clearTimer(id);
    this.#timers.extra.clear();
  }

  // Arms the timer for the planned next round (#memory.nextRoundAt, an absolute time).
  #scheduleAt(at) {
    this.#clearMain();
    this.#memory.nextRoundAt = at;
    this.#timers.main = this.#deps.setTimer(() => {
      this.#timers.main = null;
      this.#round("timer");
    }, Math.max(0, at - this.#deps.now()));
  }

  #publish() {
    try {
      this.#deps.onUpdate(this.#state);
    } catch {
      // A failing redraw must not stop the polling.
    }
  }

  async #round(trigger) {
    const status = this.#status;
    if (!status.running || status.paused) return;
    if (status.inFlight) {
      status.rerun = true;
      return;
    }
    status.inFlight = true;
    this.#clearMain();
    let delay = this.#timing.localIntervalMs;
    try {
      await this.#deps.ready();
      if (status.running && !status.paused) delay = await this.#collect(trigger);
    } catch (error) {
      this.#deps.log.warn("Dots status round failed:", error && error.name ? error.name : "Error");
    } finally {
      status.inFlight = false;
      const now = this.#deps.now();
      // Planned even while stopped or paused, so a later start or resume keeps this time.
      this.#memory.lastRoundAt = now;
      this.#memory.nextRoundAt = now + Math.max(0, delay);
      this.#publish();
      this.#finishRound();
    }
  }

  #finishRound() {
    if (!this.#status.running || this.#status.paused) return;
    if (this.#status.rerun) {
      this.#status.rerun = false;
      this.#round("rerun");
      return;
    }
    this.#scheduleAt(this.#memory.nextRoundAt);
  }

  // One round's work; returns the delay until the next round.
  async #collect() {
    const config = normalizeConfig(this.#deps.getConfig());
    const credentials = this.#deps.readCredentials(config.codexHome);
    const cache = this.#readCacheSafely(config.codexHome, credentials.ok ? credentials.accountId : null);
    this.#patch({ source: config.statusSource, cache });
    if (config.statusSource === "local") {
      this.#patch({ error: null, signedOut: null });
      return this.#timing.localIntervalMs;
    }
    if (!credentials.ok) {
      if (credentials.reason !== "unreadable") this.#patch({ signedOut: credentials.reason, error: null, network: null });
      return this.#timing.localIntervalMs;
    }
    this.#patch({ signedOut: null });
    if (isTokenExpired(credentials, this.#deps.now())) {
      this.#patch({ error: { category: "authExpired", at: this.#deps.now() } });
      return this.#timing.localIntervalMs;
    }
    this.#liftGateForNewToken(credentials);
    const waiting = this.#waitRemaining();
    if (waiting > 0) return Math.min(waiting, this.#timing.localIntervalMs);
    if (!this.#canSpend(0)) return this.#budgetDelay();
    return this.#fetchStatus(credentials);
  }

  async #fetchStatus(credentials) {
    const list = await this.#deps.client.fetchList(credentials);
    if (!list.ok) return this.#applyFailure(list, credentials);
    this.#memory.failures = 0;
    this.#memory.gate = null;
    const previous = this.#state.network ? this.#state.network.activity : {};
    const activity = {};
    for (const dot of list.dots) {
      if (Object.prototype.hasOwnProperty.call(previous, dot.id)) activity[dot.id] = previous[dot.id];
    }
    this.#patch({ network: Object.freeze({ dots: list.dots, activity, noAccess: false, at: this.#deps.now() }), error: null });
    const available = list.dots.filter((dot) => dot.available);
    const gatedDelay = await this.#fetchActivity(credentials, available);
    return gatedDelay === null ? this.#jittered(this.#intervalFor(available.length)) : gatedDelay;
  }

  // Asks for one dot's activity; returns the delay of the wait a 429 or 401 starts, else null.
  async #fetchActivity(credentials, available) {
    if (available.length === 0 || !this.#canSpend(1)) return null;
    const dot = available[this.#memory.rotation % available.length];
    this.#memory.rotation += 1;
    const result = await this.#deps.client.fetchActivity(credentials, dot.id);
    if (result.ok) {
      const network = this.#state.network;
      this.#patch({ network: Object.freeze({ ...network, activity: { ...network.activity, [dot.id]: result.inProgress } }) });
      return null;
    }
    const network = this.#state.network;
    this.#patch({ network: Object.freeze({ ...network, activity: { ...network.activity, [dot.id]: null } }) });
    if (result.category === "rateLimited" || AUTH_GATES.has(result.category)) return this.#applyFailure(result, credentials);
    return null;
  }

  // Records a failed request and returns the delay until the next round.
  #applyFailure(result, credentials) {
    const at = this.#deps.now();
    const { category } = result;
    const timing = this.#timing;
    if (category === "noAccess") {
      this.#memory.failures = 0;
      this.#setGate("noAccess", at + timing.noAccessWaitMs, credentials);
      this.#patch({ network: Object.freeze({ dots: [], activity: {}, noAccess: true, at }), error: null });
    } else if (AUTH_GATES.has(category)) {
      this.#setGate(category, at + timing.rejectedWaitMs, credentials);
      this.#patch({ error: { category, at } });
    } else if (category === "rateLimited") {
      const wait = result.retryAfterMs === null || result.retryAfterMs === undefined ? timing.rateLimitDefaultMs : result.retryAfterMs;
      this.#setGate("rateLimited", at + clamp(wait, timing.rateLimitMinMs, timing.rateLimitMaxMs), credentials);
      this.#patch({ error: { category, at } });
    } else {
      this.#memory.failures += 1;
      const backoff = Math.min(timing.intervalMs * 2 ** (this.#memory.failures - 1), timing.backoffMaxMs);
      this.#setGate("backoff", at + backoff, credentials);
      this.#patch({ error: { category: category || "network", at } });
    }
    return Math.min(this.#waitRemaining(), timing.localIntervalMs);
  }

  #setGate(reason, until, credentials) {
    this.#memory.gate = { reason, until, expiresAt: credentials && credentials.ok ? credentials.expiresAt : null };
  }

  // The app refreshed the token (a new exp): a sign-in wait is over.
  #liftGateForNewToken(credentials) {
    const { gate } = this.#memory;
    if (gate && AUTH_GATES.has(gate.reason) && gate.expiresAt !== credentials.expiresAt) this.#memory.gate = null;
  }

  #waitRemaining() {
    const { gate } = this.#memory;
    return gate ? Math.max(0, gate.until - this.#deps.now()) : 0;
  }

  #canSpend(reserve) {
    const now = this.#deps.now();
    const requests = this.#requests;
    while (requests.length > 0 && requests[0] <= now - this.#timing.budgetWindowMs) requests.shift();
    const ok = requests.length + 1 + reserve <= this.#timing.budgetPerHour;
    if (reserve === 0) {
      if (!ok && !this.#memory.budgetLogged) this.#deps.log.warn("Dots status: hourly request budget used up, skipping requests for now");
      this.#memory.budgetLogged = !ok;
    }
    return ok;
  }

  #budgetDelay() {
    const requests = this.#requests;
    const until = requests.length > 0 ? requests[0] + this.#timing.budgetWindowMs - this.#deps.now() : this.#timing.localIntervalMs;
    return Math.max(1_000, Math.min(until, this.#timing.localIntervalMs));
  }

  #intervalFor(dotCount) {
    const { intervalMs, maxStretch, stretchPerDot } = this.#timing;
    return intervalMs * Math.min(maxStretch, 1 + stretchPerDot * Math.max(0, dotCount - 1));
  }

  #jittered(ms) {
    const { jitter } = this.#timing;
    return Math.round(ms * (1 - jitter + 2 * jitter * this.#deps.random()));
  }

  #readCacheSafely(codexHome, accountId) {
    try {
      return this.#deps.readCache({ codexHome, accountId }) || null;
    } catch {
      return null;
    }
  }

  // Catches up only when the planned round is due; a round still in flight plans the next one when it ends.
  #resume() {
    const { nextRoundAt } = this.#memory;
    if (this.#status.inFlight) return Promise.resolve();
    if (nextRoundAt === null || this.#deps.now() >= nextRoundAt) return this.#round("resume");
    this.#scheduleAt(nextRoundAt);
    return Promise.resolve();
  }
}

function withDefaults(options) {
  const noop = () => {};
  const log = options.log || {};
  return {
    client: options.client,
    readCredentials: options.readCredentials,
    readCache: options.readCache || (() => null),
    getConfig: options.getConfig || (() => ({})),
    ready: options.ready || (async () => {}),
    onUpdate: options.onUpdate || noop,
    log: { info: typeof log.info === "function" ? log.info.bind(log) : noop, warn: typeof log.warn === "function" ? log.warn.bind(log) : noop },
    now: options.now || Date.now,
    setTimer: options.setTimer || setTimeout,
    clearTimer: options.clearTimer || clearTimeout,
    random: options.random || Math.random,
  };
}

function normalizeConfig(config) {
  const value = config && typeof config === "object" ? config : {};
  return {
    codexHome: typeof value.codexHome === "string" ? value.codexHome : "",
    statusSource: value.statusSource === "local" ? "local" : "auto",
  };
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

module.exports = {
  DEFAULT_TIMING,
  createDotsPoller,
};
