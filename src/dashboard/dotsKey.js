"use strict";

// Everything the ChatGPT Dots key needs besides drawing, so src/plugin.js only dispatches: the shared status
// poller (running while a Dots key is loaded, paused while every Flexbar is unplugged, refreshed when the Codex home
// or the status source changes), the press (debounced, then refreshed 20 s and 90 s later, when the dot's unread
// state has likely changed) and each key's face. Logs only route, statuses, categories, counts and the state.

const { collectorOptionsFromConfig } = require("../collectors/pathOverrides");
const { createDotsClient } = require("../collectors/chatgptDots");
const { readDotsCredentials } = require("../collectors/dotsAuth");
const { createDotsLocalCache } = require("../collectors/dotsLocalCache");
const { createDotsPoller } = require("../collectors/dotsPoller");
const { openChatGptDots } = require("./dotsAction");
const { buildDotsFace, dotsStatusSummary } = require("./dotsView");
const { dotsConfigFromKey } = require("./pluginEvents");
const { t } = require("./i18n");

const PRESS_DEBOUNCE_MS = 1_500;
const PRESS_REFRESH_DELAYS_MS = Object.freeze([20_000, 90_000]);

function createDotsKeyController(options) {
  return new DotsKeyController(options);
}

class DotsKeyController {
  #now;
  #log;
  #getPluginConfig;
  #openDots;
  #notify;
  #onUpdate;
  #poller;
  #devices = new Map();
  #lastPressAt = -Infinity;
  #lastLogged = "";
  #paused = false;
  #config;

  constructor(options) {
    this.#now = options.now || Date.now;
    this.#log = options.log || {};
    this.#getPluginConfig = options.getPluginConfig || (() => ({}));
    this.#openDots = options.openDots || (() => openChatGptDots());
    this.#notify = options.notify || (() => {});
    this.#onUpdate = options.onUpdate || (() => {});
    this.#config = dotsConfig(this.#getPluginConfig());
    this.#poller = options.poller || createDefaultPoller({
      getConfig: () => dotsConfig(this.#getPluginConfig()),
      ready: options.ready,
      log: this.#log,
      onUpdate: (state) => this.handlePollerUpdate(state),
    });
  }

  /** Runs the poller while at least one Dots key is loaded. */
  setActive(active) {
    if (!active) {
      this.#poller.stop();
      return Promise.resolve();
    }
    return this.#poller.start();
  }

  deviceConnected(serialNumber) {
    if (!serialNumber) return;
    this.#devices.set(serialNumber, true);
    this.#syncPaused();
  }

  applyDeviceStatuses(statuses) {
    for (const { serialNumber, status } of statuses || []) {
      if (serialNumber) this.#devices.set(serialNumber, status === "connected");
    }
    this.#syncPaused();
  }

  /** Refreshes at once when the Codex home or the status source changed; a new home lifts sign-in waits. */
  configChanged() {
    const next = dotsConfig(this.#getPluginConfig());
    const previous = this.#config;
    if (next.codexHome === previous.codexHome && next.statusSource === previous.statusSource) return Promise.resolve();
    this.#config = next;
    return this.#poller.refreshNow({ resetGates: next.codexHome !== previous.codexHome });
  }

  async press(serialNumber, language) {
    const time = this.#now();
    if (time - this.#lastPressAt < PRESS_DEBOUNCE_MS) return { ok: true, debounced: true };
    this.#lastPressAt = time;
    const result = await this.#openDots();
    if (!result.ok) callLog(this.#log, "warn", "Failed to open ChatGPT Dots:", result.reason);
    this.#notify(serialNumber, t(language, pressMessageKey(result)), result.ok ? "success" : "error");
    this.#poller.requestRefresh(PRESS_REFRESH_DELAYS_MS);
    return result;
  }

  /** The face one key shows (with its own name setting) and a plain-text title for when rendering fails. */
  keyView(key, language) {
    const { showName } = dotsConfigFromKey(key);
    const view = buildDotsFace(this.#poller.getState(), { now: this.#now(), language, showName });
    return { view, fallbackTitle: `${t(language, "dotsLabel")} ${view.title}` };
  }

  status() {
    return dotsStatusSummary(this.#poller.getState(), { now: this.#now() });
  }

  handlePollerUpdate(state) {
    const summary = dotsStatusSummary(state, { now: this.#now() });
    const entry = { ...this.#poller.getDiagnostics(), state: summary.state, degraded: summary.degraded };
    const serialized = JSON.stringify(entry);
    if (serialized !== this.#lastLogged) {
      this.#lastLogged = serialized;
      callLog(this.#log, "info", "Dots status:", entry);
    }
    this.#onUpdate();
  }

  #syncPaused() {
    const devices = [...this.#devices.values()];
    const allAway = devices.length > 0 && devices.every((connected) => !connected);
    if (allAway === this.#paused) return;
    this.#paused = allAway;
    this.#poller.setPaused(allAway);
  }
}

function createDefaultPoller({ getConfig, ready, log, onUpdate }) {
  const cache = createDotsLocalCache();
  let poller = null;
  const client = createDotsClient({ onRequest: (event) => poller.recordRequest(event) });
  poller = createDotsPoller({
    client,
    readCredentials: (codexHome) => readDotsCredentials(codexHome),
    readCache: (args) => cache.read(args),
    getConfig,
    ready,
    onUpdate,
    log,
  });
  return poller;
}

/** The plugin config parts the Dots status depends on. */
function dotsConfig(pluginConfig) {
  return {
    codexHome: collectorOptionsFromConfig(pluginConfig || {}).codexHome,
    statusSource: pluginConfig && pluginConfig.dotsStatusSource === "local" ? "local" : "auto",
  };
}

function pressMessageKey(result) {
  if (!result.ok) return "dotsOpenFailed";
  return result.target === "web" ? "dotsOpenedWeb" : "dotsOpening";
}

function callLog(log, level, ...args) {
  try {
    if (log && typeof log[level] === "function") log[level](...args);
  } catch {
    // Logging must never break the key.
  }
}

module.exports = {
  PRESS_DEBOUNCE_MS,
  PRESS_REFRESH_DELAYS_MS,
  createDotsKeyController,
  dotsConfig,
};
