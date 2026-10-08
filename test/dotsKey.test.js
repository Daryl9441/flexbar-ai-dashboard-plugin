"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createDotsKeyController } = require("../src/dashboard/dotsKey");
const { dotsConfigFromKey } = require("../src/dashboard/pluginEvents");
const { DOTS_FACE } = require("../src/dashboard/dotsView");

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const DOT_NAME = "Test Dot";
const TBO_ID = "tbo~test-0001";
const FAKE_ACCOUNT = "acct-" + "0".repeat(8);

function fakePoller(state = null) {
  const calls = [];
  let current = state || { source: "auto", network: null, cache: null, error: null, signedOut: null };
  return {
    calls,
    setState(next) {
      current = next;
    },
    start: () => {
      calls.push(["start"]);
      return Promise.resolve();
    },
    stop: () => calls.push(["stop"]),
    setPaused: (paused) => {
      calls.push(["setPaused", paused]);
      return Promise.resolve();
    },
    requestRefresh: (delays) => calls.push(["requestRefresh", delays]),
    refreshNow: (options) => {
      calls.push(["refreshNow", options]);
      return Promise.resolve();
    },
    getState: () => current,
    getDiagnostics: () => ({ source: "auto", route: "system-proxy", list: { status: 200, category: null }, activity: null, dots: 1, error: null }),
  };
}

function controller(options = {}) {
  let time = options.time || NOW;
  const notes = [];
  const logs = [];
  let pluginConfig = options.pluginConfig || { pathOverrides: { CODEX_HOME: "/Users/me/.codex" }, dotsStatusSource: "auto" };
  const poller = options.poller || fakePoller(options.state);
  const opened = [];
  const dots = createDotsKeyController({
    poller,
    getPluginConfig: () => pluginConfig,
    openDots: async () => {
      opened.push(time);
      return options.openResult || { ok: true, target: "app" };
    },
    notify: (serialNumber, message, level) => notes.push({ serialNumber, message, level }),
    onUpdate: () => {},
    log: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    now: () => time,
  });
  return {
    dots,
    poller,
    notes,
    logs,
    opened,
    advance: (ms) => {
      time += ms;
    },
    setPluginConfig: (next) => {
      pluginConfig = next;
    },
  };
}

test("the poller runs only while a Dots key is loaded", async () => {
  const { dots, poller } = controller();
  await dots.setActive(true);
  await dots.setActive(true);
  dots.setActive(false);
  assert.deepEqual(poller.calls, [["start"], ["start"], ["stop"]]);
});

test("the poller pauses only while every known Flexbar is unplugged", () => {
  const { dots, poller } = controller();
  dots.deviceConnected("001100AA0001");
  dots.deviceConnected("0123456789AB");
  dots.applyDeviceStatuses([{ serialNumber: "001100AA0001", status: "disconnected" }]);
  assert.deepEqual(poller.calls, []);
  dots.applyDeviceStatuses([{ serialNumber: "0123456789AB", status: "disconnected" }]);
  assert.deepEqual(poller.calls, [["setPaused", true]]);
  dots.applyDeviceStatuses([{ serialNumber: "0123456789AB", status: "disconnected" }]);
  dots.applyDeviceStatuses([{ serialNumber: "001100AA0001", status: "connected" }]);
  assert.deepEqual(poller.calls, [["setPaused", true], ["setPaused", false]]);
  dots.applyDeviceStatuses([{ serialNumber: "001100AA0001", status: "disconnected" }]);
  dots.deviceConnected("001100AA0001");
  assert.deepEqual(poller.calls.slice(2), [["setPaused", true], ["setPaused", false]]);
});

test("a press opens Dots once per 1.5 s, says so and refreshes 20 s and 90 s later", async () => {
  const { dots, poller, notes, opened, advance } = controller();
  const first = await dots.press("001100AA0001", "en");
  advance(1_000);
  const second = await dots.press("001100AA0001", "en");
  advance(600);
  await dots.press("001100AA0001", "zh");

  assert.deepEqual(first, { ok: true, target: "app" });
  assert.deepEqual(second, { ok: true, debounced: true });
  assert.equal(opened.length, 2);
  assert.deepEqual(notes, [
    { serialNumber: "001100AA0001", message: "Opening ChatGPT Dots", level: "success" },
    { serialNumber: "001100AA0001", message: "正在打开 ChatGPT Dots", level: "success" },
  ]);
  assert.deepEqual(poller.calls.filter(([name]) => name === "requestRefresh"), [
    ["requestRefresh", [20_000, 90_000]],
    ["requestRefresh", [20_000, 90_000]],
  ]);
});

test("the web fallback and a failure are reported", async () => {
  const web = controller({ openResult: { ok: true, target: "web" } });
  await web.dots.press("001100AA0001", "en");
  assert.deepEqual(web.notes[0], { serialNumber: "001100AA0001", message: "Opened Dots in the browser", level: "success" });

  const failed = controller({ openResult: { ok: false, target: null, reason: "openFailed" } });
  await failed.dots.press("001100AA0001", "en");
  assert.deepEqual(failed.notes[0], { serialNumber: "001100AA0001", message: "Could not open ChatGPT Dots", level: "error" });
  assert.ok(failed.logs.some((args) => /Failed to open ChatGPT Dots/.test(String(args[0]))));
});

test("only a changed Codex home or status source refreshes at once", async () => {
  const { dots, poller, setPluginConfig } = controller();
  dots.configChanged();
  assert.deepEqual(poller.calls, []);

  setPluginConfig({ pathOverrides: { CODEX_HOME: "/Users/me/.codex" }, dotsStatusSource: "local" });
  dots.configChanged();
  setPluginConfig({ pathOverrides: { CODEX_HOME: "/Users/me/other-codex" }, dotsStatusSource: "local" });
  dots.configChanged();
  assert.deepEqual(poller.calls, [["refreshNow", { resetGates: false }], ["refreshNow", { resetGates: true }]]);
});

test("each key renders the shared state with its own name setting", () => {
  const state = {
    source: "auto",
    network: { dots: [{ id: TBO_ID, name: DOT_NAME, available: true, unread: false, lastCheckInAt: NOW - 3_600_000 }], activity: {}, at: NOW },
    cache: null,
    error: null,
    signedOut: null,
  };
  const { dots } = controller({ state });
  const shown = dots.keyView({ uid: 1, data: { showName: true } }, "en");
  assert.equal(shown.view.kind, DOTS_FACE.IDLE);
  assert.equal(shown.view.detail, DOT_NAME);
  assert.equal(shown.fallbackTitle, "Dots Idle");
  assert.equal(dots.keyView({ uid: 2, data: { showName: false } }, "en").view.detail, "Check-in 1h ago");
  assert.equal(dots.keyView({ uid: 3, data: {} }, "zh").view.title, "空闲");

  assert.deepEqual(dots.status(), { state: DOTS_FACE.IDLE, degraded: false, source: "network", updatedAt: NOW });
});

test("dotsConfigFromKey reads showName from every place FlexDesigner may put it", () => {
  assert.deepEqual(dotsConfigFromKey({ data: { showName: false } }), { showName: false });
  assert.deepEqual(dotsConfigFromKey({ data: { config: { showName: false } } }), { showName: false });
  assert.deepEqual(dotsConfigFromKey({ config: { showName: false }, data: { showName: true } }), { showName: false });
  assert.deepEqual(dotsConfigFromKey({ showName: false, data: {} }), { showName: false });
  assert.deepEqual(dotsConfigFromKey({ data: { showName: "false" } }), { showName: false });
  assert.deepEqual(dotsConfigFromKey({ data: {} }), { showName: true });
  assert.deepEqual(dotsConfigFromKey(null), { showName: true });
});

test("status changes are logged once each, with counts and categories only", async () => {
  const poller = fakePoller();
  const { dots, logs } = controller({ poller });
  const state = {
    source: "auto",
    network: { dots: [{ id: TBO_ID, name: DOT_NAME, available: true }], activity: {}, at: NOW },
    cache: null,
    error: null,
    signedOut: null,
  };
  poller.setState(state);
  dots.handlePollerUpdate(state);
  dots.handlePollerUpdate(state);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "Dots status:");
  assert.deepEqual(logs[0][1], { source: "auto", route: "system-proxy", list: { status: 200, category: null }, activity: null, dots: 1, error: null, state: "idle", degraded: false });
  const text = JSON.stringify(logs);
  for (const secret of [DOT_NAME, TBO_ID, FAKE_ACCOUNT]) assert.ok(!text.includes(secret));
});

test("the default wiring reads the local cache without any request in local mode", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-dots-key-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // The app had this dot 5 minutes ago; the age comes from that, not from the file's mtime (just now).
  const selectedAt = new Date(Date.now() - 5 * 60_000 - 1_000).toISOString();
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
    "electron-persisted-atom-state": {
      "primary-aeon-selection-v1": {
        accountId: null,
        response: { selection: { selected_at: selectedAt }, profile: { id: TBO_ID, display_name: DOT_NAME, status: "active", is_paused: true } },
      },
    },
  }));
  let updates = 0;
  const dots = createDotsKeyController({
    getPluginConfig: () => ({ pathOverrides: { CODEX_HOME: home }, dotsStatusSource: "local" }),
    notify: () => {},
    onUpdate: () => {
      updates += 1;
    },
    log: { info() {}, warn() {} },
  });
  try {
    await dots.setActive(true);
    const { view } = dots.keyView({ data: { showName: true } }, "en");
    assert.equal(view.kind, DOTS_FACE.PAUSED);
    assert.equal(view.hollow, true);
    assert.equal(view.detail, "Test Dot · Cache 5m");
    assert.ok(updates >= 1);
  } finally {
    dots.setActive(false);
  }
});
