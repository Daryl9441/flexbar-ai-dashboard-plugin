"use strict";

const { execFile, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRateLimitedLogger,
  describeError,
  installUnhandledRejectionGuard,
  safeCall,
  waitAtMost,
} = require("../src/dashboard/hostSafety");
const {
  DEFAULT_REFRESH_AFTER_MS,
  DEFAULT_RELOAD_GRACE_MS,
  DRAW_RESULT,
  createKeyDrawCache,
} = require("../src/dashboard/keyDrawCache");
const { extractDeviceStatuses } = require("../src/dashboard/pluginEvents");

function recordingLogger() {
  const lines = [];
  const logger = {};
  for (const level of ["info", "warn", "error"]) {
    logger[level] = (...args) => lines.push({ level, text: args.join(" ") });
  }
  return { logger, lines };
}

function fakeClock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Fake host draw: records calls and answers with the configured outcome.
function fakeHost() {
  const calls = [];
  let outcome = "success";
  const draw = (serialNumber, key, type, base64) => {
    calls.push({ serialNumber, uid: key.uid, type, base64, title: key.title });
    if (outcome === "throw") throw new Error("socket not open");
    if (outcome === "reject") return Promise.reject(new Error("Request failed: device disconnected"));
    return Promise.resolve({});
  };
  return {
    calls,
    draw,
    fail(mode = "reject") {
      outcome = mode;
    },
    recover() {
      outcome = "success";
    },
  };
}

function key(uid, title = "x") {
  return { uid, cid: "com.aspen.flexbar-ai-dashboard.session", title, style: { showIcon: false, showTitle: false } };
}

test("safeCall resolves with the host call value", async () => {
  assert.deepEqual(await safeCall("ok", () => Promise.resolve(42)), { ok: true, value: 42 });
  assert.deepEqual(await safeCall("sync", () => "plain"), { ok: true, value: "plain" });
});

test("safeCall turns rejections and synchronous throws into logged results", async () => {
  const { logger, lines } = recordingLogger();
  const log = createRateLimitedLogger(logger, { intervalMs: 0 });

  const rejected = await safeCall("Draw key 1", () => Promise.reject(new Error("Request failed")), { log });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /Request failed/);

  const thrown = await safeCall("Show snackbar", () => {
    throw new Error("invalid level");
  }, { log, level: "error" });
  assert.equal(thrown.ok, false);

  assert.deepEqual(lines.map((line) => line.level), ["warn", "error"]);
  assert.match(lines[0].text, /Draw key 1 failed: Error: Request failed/);
  assert.match(lines[1].text, /Show snackbar failed: Error: invalid level/);
});

test("safeCall also accepts a plain logger and an onError callback", async () => {
  const { logger, lines } = recordingLogger();
  const errors = [];
  await safeCall("Save plugin config", () => Promise.reject(new Error("nope")), {
    log: logger,
    onError: (error) => errors.push(error.message),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /Save plugin config failed: Error: nope/);
  assert.deepEqual(errors, ["nope"]);
});

test("safeCall with a timeout gives up on a host call that never answers", { timeout: 5_000 }, async () => {
  const { logger, lines } = recordingLogger();
  const errors = [];
  // plugin.getConfig()/setConfig() are sent with SDK timeout 0: they never settle.
  const neverAnswered = await safeCall("Save plugin config", () => new Promise(() => {}), {
    log: logger,
    level: "error",
    timeoutMs: 20,
    onError: (error) => errors.push(error.code),
  });
  assert.equal(neverAnswered.ok, false);
  assert.equal(neverAnswered.timedOut, true);
  assert.equal(neverAnswered.error.name, "TimeoutError");
  assert.deepEqual(errors, ["ETIMEDOUT"]);
  assert.match(lines[0].text, /Save plugin config failed: TimeoutError: Save plugin config got no answer within 20ms/);

  // A timely answer wins and clears the timer; a late rejection is ignored.
  assert.deepEqual(await safeCall("fast", () => Promise.resolve("v"), { timeoutMs: 1_000 }), { ok: true, value: "v" });
  const late = deferred();
  const result = await safeCall("late", () => late.promise, { log: logger, timeoutMs: 10 });
  assert.equal(result.timedOut, true);
  late.reject(new Error("too late"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lines.length, 2, "the late rejection is not reported a second time");
});

test("waitAtMost resolves when the promise settles or the time is up, and never rejects", { timeout: 5_000 }, async () => {
  assert.equal(await waitAtMost(Promise.resolve("x"), 1_000), true);
  assert.equal(await waitAtMost(Promise.reject(new Error("nope")), 1_000), true);
  assert.equal(await waitAtMost(new Promise(() => {}), 15), false);
  assert.equal(await waitAtMost(new Promise(() => {}), 0), false);
  assert.equal(await waitAtMost(new Promise(() => {}), -5), false);
});

test("rate-limited logger keeps one line per category per interval and counts the rest", () => {
  const clock = fakeClock();
  const { logger, lines } = recordingLogger();
  const log = createRateLimitedLogger(logger, { intervalMs: 60_000, now: clock.now });

  assert.equal(log.warn("draw:SN1", "Draw failed"), true);
  clock.advance(2_000);
  assert.equal(log.warn("draw:SN1", "Draw failed"), false);
  assert.equal(log.warn("draw:SN1", "Draw failed"), false);
  assert.equal(log.warn("draw:SN2", "Draw failed on other device"), true);
  clock.advance(60_000);
  assert.equal(log.warn("draw:SN1", "Draw failed again"), true);

  assert.deepEqual(lines.map((line) => line.text), [
    "Draw failed",
    "Draw failed on other device",
    "Draw failed again (2 similar message(s) suppressed)",
  ]);
});

test("describeError keeps log lines short and drops embedded images", () => {
  const payload = `Request timed out, command: draw, payload: {"base64":"data:image/png;base64,${"A".repeat(5000)}"}`;
  const text = describeError(new Error(payload));
  assert.ok(text.length <= 303, `expected a short message, got ${text.length} chars`);
  assert.match(text, /base64,<omitted>/);
  assert.doesNotMatch(text, /AAAAAAAA/);
  assert.equal(describeError("plain"), "plain");
  assert.equal(describeError({ code: 1 }), "{\"code\":1}");
});

test("unhandled rejection guard registers a single listener and logs the reason", () => {
  const target = new EventEmitter();
  const { logger, lines } = recordingLogger();
  const first = installUnhandledRejectionGuard(target, logger);
  const second = installUnhandledRejectionGuard(target, logger);

  assert.equal(first, second);
  assert.equal(target.listenerCount("unhandledRejection"), 1);
  target.emit("unhandledRejection", new Error("Request timed out"));
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /Unhandled promise rejection \(plugin kept alive\): Error: Request timed out/);
});

test("unhandled rejection guard keeps a real Node process alive", () => {
  const hostSafetyPath = path.join(__dirname, "..", "src", "dashboard", "hostSafety.js");
  const script = `
    const { installUnhandledRejectionGuard } = require(${JSON.stringify(hostSafetyPath)});
    if (process.env.INSTALL_GUARD === "1") {
      installUnhandledRejectionGuard(process, { error: (...args) => console.log("LOGGED", ...args) });
    }
    Promise.reject(new Error("Request failed: device disconnected"));
    setTimeout(() => console.log("STILL_ALIVE"), 50);
  `;
  const run = (installGuard) => spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, INSTALL_GUARD: installGuard ? "1" : "0" },
    timeout: 10_000,
  });

  const unguarded = run(false);
  assert.notEqual(unguarded.status, 0, "without the guard Node exits on the rejection");
  assert.doesNotMatch(unguarded.stdout, /STILL_ALIVE/);

  const guarded = run(true);
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /LOGGED Unhandled promise rejection \(plugin kept alive\): Error: Request failed: device disconnected/);
  assert.match(guarded.stdout, /STILL_ALIVE/);
});

test("key draw cache skips unchanged payloads and redraws changed ones", async () => {
  const host = fakeHost();
  const cache = createKeyDrawCache({ draw: host.draw });
  const sessionKey = key(1);

  assert.equal(await cache.drawKey("SN1", sessionKey, "base64", "data:image/png;base64,AAA"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", sessionKey, "base64", "data:image/png;base64,AAA"), DRAW_RESULT.UNCHANGED);
  assert.equal(await cache.drawKey("SN1", sessionKey, "base64", "data:image/png;base64,BBB"), DRAW_RESULT.DRAWN);

  sessionKey.title = "Loading";
  sessionKey.style.showTitle = true;
  assert.equal(await cache.drawKey("SN1", sessionKey, "draw"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", sessionKey, "draw"), DRAW_RESULT.UNCHANGED);

  // Same image on another device or another key is a separate cache entry.
  assert.equal(await cache.drawKey("SN2", key(1), "base64", "data:image/png;base64,AAA"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "data:image/png;base64,AAA"), DRAW_RESULT.DRAWN);

  assert.equal(host.calls.length, 5);
});

test("key draw cache does not resend a payload that is still in flight", async () => {
  const pending = deferred();
  const calls = [];
  const cache = createKeyDrawCache({
    draw: (serialNumber, drawnKey, type, base64) => {
      calls.push(base64);
      return pending.promise;
    },
  });

  const first = cache.drawKey("SN1", key(1), "base64", "img-a");
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-a"), DRAW_RESULT.UNCHANGED);
  pending.resolve({});
  assert.equal(await first, DRAW_RESULT.DRAWN);
  assert.deepEqual(calls, ["img-a"]);
});

test("key draw cache never rejects and retries failed draws with capped backoff", async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const { logger, lines } = recordingLogger();
  const cache = createKeyDrawCache({
    draw: host.draw,
    now: clock.now,
    log: createRateLimitedLogger(logger, { now: clock.now }),
    retryBaseMs: 2_000,
    retryMaxMs: 8_000,
  });

  host.fail("reject");
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img"), DRAW_RESULT.FAILED);
  // Within the backoff window nothing is sent, even for a new image.
  clock.advance(1_999);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-2"), DRAW_RESULT.BACKOFF);
  clock.advance(1);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-2"), DRAW_RESULT.FAILED);
  clock.advance(3_999);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-2"), DRAW_RESULT.BACKOFF);
  clock.advance(1);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-2"), DRAW_RESULT.FAILED);
  // Third failure would be 8s; fourth is capped at retryMaxMs (8s) as well.
  clock.advance(8_000);
  host.fail("throw");
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-2"), DRAW_RESULT.FAILED);
  clock.advance(7_999);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-2"), DRAW_RESULT.BACKOFF);
  clock.advance(1);

  host.recover();
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-2"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-2"), DRAW_RESULT.UNCHANGED);
  // After a success the failure count is reset: the next failure backs off 2s again.
  host.fail("reject");
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-3"), DRAW_RESULT.FAILED);
  clock.advance(2_000);
  host.recover();
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-3"), DRAW_RESULT.DRAWN);

  assert.equal(host.calls.length, 7);
  // Five failures within a minute on one device produce a single log line.
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /Draw key 1 on SN1 failed: Error: Request failed: device disconnected/);
});

test("a failure of a superseded draw does not discard the newer draw", async () => {
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  let sent = 0;
  const cache = createKeyDrawCache({ draw: () => pending[sent++].promise });

  const oldDraw = cache.drawKey("SN1", key(1), "base64", "old");
  const newDraw = cache.drawKey("SN1", key(1), "base64", "new");
  second.resolve({});
  first.reject(new Error("Request timed out"));

  assert.equal(await newDraw, DRAW_RESULT.DRAWN);
  assert.equal(await oldDraw, DRAW_RESULT.FAILED);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "new"), DRAW_RESULT.UNCHANGED);
  assert.equal(sent, 2);
});

test("key draw cache stops drawing to a disconnected device and redraws everything on reconnect", async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const cache = createKeyDrawCache({ draw: host.draw, now: clock.now, probeIntervalMs: 30_000 });

  await cache.drawKey("SN1", key(1), "base64", "img-1");
  await cache.drawKey("SN1", key(2), "base64", "img-2");
  await cache.drawKey("SN2", key(1), "base64", "img-1");
  assert.equal(host.calls.length, 3);

  cache.markDeviceDisconnected("SN1");
  assert.equal(cache.isDeviceDisconnected("SN1"), true);
  for (let tick = 0; tick < 10; tick += 1) {
    clock.advance(2_000);
    assert.equal(await cache.drawKey("SN1", key(1), "base64", `img-1-${tick}`), DRAW_RESULT.DISCONNECTED);
    assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.DISCONNECTED);
  }
  // Other devices are unaffected.
  assert.equal(await cache.drawKey("SN2", key(1), "base64", "img-1"), DRAW_RESULT.UNCHANGED);
  assert.equal(host.calls.length, 3);

  cache.markDeviceConnected("SN1");
  assert.equal(cache.isDeviceDisconnected("SN1"), false);
  // The host reloads the keys right after a reconnect; draws wait for that
  // reload for at most the grace period.
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.HELD);
  clock.advance(cache.reloadGraceMs);
  // Unchanged content is still redrawn: the device screen was reset.
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1-9"), DRAW_RESULT.DRAWN);
  assert.equal(host.calls.length, 5);
});

test("a reconnected device is drawn as soon as its keys are reloaded", async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const cache = createKeyDrawCache({ draw: host.draw, now: clock.now });
  assert.equal(cache.reloadGraceMs, DEFAULT_RELOAD_GRACE_MS);

  await cache.drawKey("SN1", key(1), "base64", "img-1");
  await cache.drawKey("SN2", key(1), "base64", "img-1");
  cache.markDeviceDisconnected("SN1");
  assert.deepEqual(cache.applyDeviceStatuses([
    { serialNumber: "SN1", status: "connected" },
    { serialNumber: "SN1", status: "connected" },
    { serialNumber: "SN3", status: "disconnected" },
    null,
  ]), ["SN1"]);
  assert.equal(cache.isDeviceDisconnected("SN3"), true);

  clock.advance(500);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1"), DRAW_RESULT.HELD);
  // Other devices are not held.
  assert.equal(await cache.drawKey("SN2", key(1), "base64", "img-1"), DRAW_RESULT.UNCHANGED);
  cache.markKeysLoaded("SN1", [key(1)]);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.DRAWN);
  assert.equal(host.calls.length, 4);

  // reloadGraceMs: 0 disables the hold.
  const eager = createKeyDrawCache({ draw: host.draw, now: clock.now, reloadGraceMs: 0 });
  eager.markDeviceConnected("SN1");
  assert.equal(await eager.drawKey("SN1", key(1), "base64", "img-1"), DRAW_RESULT.DRAWN);
});

test("a disconnected device is probed periodically and fully redrawn once a probe succeeds", async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const recovered = [];
  const cache = createKeyDrawCache({
    draw: host.draw,
    now: clock.now,
    probeIntervalMs: 30_000,
    onDeviceRecovered: (serialNumber) => recovered.push(serialNumber),
  });

  await cache.drawKey("SN1", key(1), "base64", "img-1");
  await cache.drawKey("SN1", key(2), "base64", "img-2");
  cache.markDeviceDisconnected("SN1");
  host.fail("reject");

  clock.advance(30_000);
  // Exactly one probe per interval; it fails while the device is still away.
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1"), DRAW_RESULT.FAILED);
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.DISCONNECTED);
  assert.equal(recovered.length, 0);

  clock.advance(30_000);
  host.recover();
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1"), DRAW_RESULT.DRAWN);
  assert.deepEqual(recovered, ["SN1"]);
  assert.equal(cache.isDeviceDisconnected("SN1"), false);
  // The probed key is current; the other key must be redrawn.
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1"), DRAW_RESULT.UNCHANGED);
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.DRAWN);
});

test("reloaded keys are redrawn and mark their device as connected", async () => {
  const host = fakeHost();
  const cache = createKeyDrawCache({ draw: host.draw });

  await cache.drawKey("SN1", key(1), "base64", "img-1");
  await cache.drawKey("SN1", key(2), "base64", "img-2");
  cache.markKeysLoaded("SN1", [key(1)]);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.UNCHANGED);

  cache.markDeviceDisconnected("SN1");
  cache.markKeysLoaded("SN1", [key(1)]);
  assert.equal(cache.isDeviceDisconnected("SN1"), false);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.DRAWN);
});

test("invalidation forces redraws for a key, a device or everything", async () => {
  const host = fakeHost();
  const cache = createKeyDrawCache({ draw: host.draw });
  const drawAll = () => Promise.all([
    cache.drawKey("SN1", key(1), "base64", "a"),
    cache.drawKey("SN1", key(2), "base64", "b"),
    cache.drawKey("SN2", key(1), "base64", "a"),
  ]);

  await drawAll();
  assert.deepEqual(await drawAll(), ["unchanged", "unchanged", "unchanged"]);

  cache.invalidateKey("SN1", 2);
  assert.deepEqual(await drawAll(), ["unchanged", "drawn", "unchanged"]);

  cache.invalidateSerial("SN1");
  assert.deepEqual(await drawAll(), ["drawn", "drawn", "unchanged"]);

  cache.invalidateAll();
  assert.deepEqual(await drawAll(), ["drawn", "drawn", "drawn"]);
});

test("unchanged keys are re-sent after the refresh interval", async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const cache = createKeyDrawCache({ draw: host.draw, now: clock.now, refreshAfterMs: 300_000 });

  await cache.drawKey("SN1", key(1), "base64", "img");
  clock.advance(299_999);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img"), DRAW_RESULT.UNCHANGED);
  clock.advance(1);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img"), DRAW_RESULT.DRAWN);
  assert.equal(host.calls.length, 2);
});

test("by default an unchanged key is re-sent every minute, not every refresh tick", async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const cache = createKeyDrawCache({ draw: host.draw, now: clock.now });
  assert.equal(DEFAULT_REFRESH_AFTER_MS, 60_000);
  assert.equal(cache.refreshAfterMs, 60_000);

  await cache.drawKey("SN1", key(1), "base64", "img");
  clock.advance(59_999);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img"), DRAW_RESULT.UNCHANGED);
  clock.advance(1);
  // A key the host silently reset to its default icon is fixed within a minute.
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img"), DRAW_RESULT.DRAWN);

  // Ten minutes of 2-second refresh ticks: one re-send per minute.
  host.calls.length = 0;
  for (let tick = 0; tick < 300; tick += 1) {
    clock.advance(2_000);
    await cache.drawKey("SN1", key(1), "base64", "img");
  }
  assert.equal(host.calls.length, 10);
});

// device.status payloads copied from a real FlexDesigner plugin log: an unplug
// sends two "disconnected" events, a replug one "connected" event that also
// carries `_removeDevice: true`, and plugin.alive follows about 0.5s later.
const REAL_SERIAL = "001100AA0001"; // same format as a real Flexbar serial number
const REAL_DISCONNECT_FIRST = [
  { serialNumber: REAL_SERIAL, status: "disconnected", _removeDevice: false, _sendWebEvent: false },
];
const REAL_DISCONNECT_REMOVED = [
  { serialNumber: REAL_SERIAL, status: "disconnected", _removeDevice: true, _sendWebEvent: true },
];
const REAL_RECONNECT = [
  {
    serialNumber: REAL_SERIAL,
    status: "connected",
    deviceData: { platform: "win32", firmwareVersion: "2.2.3" },
    _removeDevice: true,
    _sendWebEvent: true,
  },
];

test("device status adapter reads the real FlexDesigner device.status payloads", () => {
  assert.deepEqual(extractDeviceStatuses(REAL_DISCONNECT_FIRST), [{ serialNumber: REAL_SERIAL, status: "disconnected" }]);
  assert.deepEqual(extractDeviceStatuses(REAL_DISCONNECT_REMOVED), [{ serialNumber: REAL_SERIAL, status: "disconnected" }]);
  // Every real reconnect carries _removeDevice: true; the explicit status wins.
  assert.deepEqual(extractDeviceStatuses(REAL_RECONNECT), [{ serialNumber: REAL_SERIAL, status: "connected" }]);
});

test("device status adapter only falls back to _removeDevice without a usable status", () => {
  assert.deepEqual(extractDeviceStatuses({ serialNumber: "s1", status: " Connected " }), [
    { serialNumber: "s1", status: "connected" },
  ]);
  assert.deepEqual(extractDeviceStatuses([{ serialNumber: "s1", status: "connected", _removeDevice: true }]), [
    { serialNumber: "s1", status: "connected" },
  ]);
  assert.deepEqual(extractDeviceStatuses({ devices: [{ serialNumber: "s1", _removeDevice: true }] }), [
    { serialNumber: "s1", status: "disconnected" },
  ]);
  assert.deepEqual(extractDeviceStatuses([{ serialNumber: "s1", status: "updating", _removeDevice: true }]), [
    { serialNumber: "s1", status: "disconnected" },
  ]);
  assert.deepEqual(extractDeviceStatuses([
    { serialNumber: "s1", status: "updating" },
    { serialNumber: "s2", _removeDevice: false },
    { status: "connected" },
    null,
  ]), []);
  assert.deepEqual(extractDeviceStatuses(null), []);
});

// Replays host events against keyDrawCache the way src/plugin.js wires them:
// device.status -> applyDeviceStatuses (+ a redraw once the reload grace is
// over), plugin.alive -> markKeysLoaded + redraw, and the 2s snapshot tick.
function reconnectReplay({ events, until, tickMs = 2_000 }) {
  const clock = fakeClock(0);
  const host = fakeHost();
  const keys = [key(1), key(2), key(7)];
  const results = [];
  const cache = createKeyDrawCache({ draw: host.draw, now: clock.now });
  const timers = [];
  const redraw = (reason) => {
    for (const item of keys) {
      results.push({ at: clock.now(), uid: item.uid, reason, pending: cache.drawKey(REAL_SERIAL, item, "base64", `img-${item.uid}`) });
    }
  };
  const schedule = (at, run) => timers.push({ at, run });

  for (let at = 0; at <= until; at += tickMs) schedule(at, () => redraw("tick"));
  for (const event of events) {
    schedule(event.at, () => {
      if (event.type === "device.status") {
        // The unplugged device rejects draws; it accepts them again once back.
        if (event.payload[0].status === "connected") host.recover();
        else host.fail("reject");
        const reconnected = cache.applyDeviceStatuses(extractDeviceStatuses(event.payload));
        if (reconnected.length > 0) schedule(clock.now() + cache.reloadGraceMs + 100, () => redraw("reconnect-timer"));
      } else if (event.type === "plugin.alive") {
        host.recover();
        cache.markKeysLoaded(REAL_SERIAL, keys);
        redraw("plugin.alive");
      }
    });
  }

  return (async () => {
    while (timers.length > 0) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (next.at > until) break;
      clock.advance(next.at - clock.now());
      next.run();
      for (const result of results) {
        if (result.pending) {
          result.status = await result.pending;
          result.pending = null;
        }
      }
    }
    return {
      results,
      sentAfter: (time) => results.filter((result) => result.at >= time && result.status === DRAW_RESULT.DRAWN),
    };
  })();
}

const REAL_SEQUENCE_DISCONNECT_AT = 4_100;
const REAL_SEQUENCE_RECONNECT_AT = 9_900;

test("real unplug/replug sequence redraws every key once, right at plugin.alive", async () => {
  const replay = await reconnectReplay({
    until: 20_000,
    events: [
      { at: REAL_SEQUENCE_DISCONNECT_AT, type: "device.status", payload: REAL_DISCONNECT_FIRST },
      { at: REAL_SEQUENCE_DISCONNECT_AT + 30, type: "device.status", payload: REAL_DISCONNECT_REMOVED },
      { at: REAL_SEQUENCE_RECONNECT_AT, type: "device.status", payload: REAL_RECONNECT },
      { at: REAL_SEQUENCE_RECONNECT_AT + 500, type: "plugin.alive" },
    ],
  });

  // Nothing is sent to the unplugged device (its first probe would be 30s later).
  const whileAway = replay.results.filter((result) => result.at >= REAL_SEQUENCE_DISCONNECT_AT && result.at < REAL_SEQUENCE_RECONNECT_AT);
  assert.ok(whileAway.length > 0);
  assert.ok(whileAway.every((result) => result.status === DRAW_RESULT.DISCONNECTED), JSON.stringify(whileAway));
  // Between "connected" and plugin.alive the host is about to reset the keys anyway.
  const beforeReload = replay.results.filter((result) => result.at >= REAL_SEQUENCE_RECONNECT_AT && result.at < REAL_SEQUENCE_RECONNECT_AT + 500);
  assert.ok(beforeReload.every((result) => result.status === DRAW_RESULT.HELD), JSON.stringify(beforeReload));

  const redrawn = replay.sentAfter(REAL_SEQUENCE_RECONNECT_AT);
  assert.deepEqual(redrawn.map((result) => result.uid), [1, 2, 7]);
  assert.ok(redrawn.every((result) => result.at === REAL_SEQUENCE_RECONNECT_AT + 500 && result.reason === "plugin.alive"));
  // Later ticks and the reconnect timer find every key current: no second draw.
  assert.ok(replay.results
    .filter((result) => result.at > REAL_SEQUENCE_RECONNECT_AT + 500)
    .every((result) => result.status === DRAW_RESULT.UNCHANGED));
});

test("a reconnect without plugin.alive is redrawn once the reload grace period ends", async () => {
  const replay = await reconnectReplay({
    until: 20_000,
    events: [
      { at: REAL_SEQUENCE_DISCONNECT_AT, type: "device.status", payload: REAL_DISCONNECT_FIRST },
      { at: REAL_SEQUENCE_DISCONNECT_AT + 30, type: "device.status", payload: REAL_DISCONNECT_REMOVED },
      { at: REAL_SEQUENCE_RECONNECT_AT, type: "device.status", payload: REAL_RECONNECT },
    ],
  });

  const redrawn = replay.sentAfter(REAL_SEQUENCE_RECONNECT_AT);
  assert.equal(redrawn.length, 3);
  for (const result of redrawn) {
    const delay = result.at - REAL_SEQUENCE_RECONNECT_AT;
    assert.ok(delay >= 1_500 && delay <= 2_000, `key ${result.uid} redrawn ${delay}ms after the reconnect`);
  }
});

test("plugin.alive arriving before the connected event never leaves keys blocked", async () => {
  const replay = await reconnectReplay({
    until: 20_000,
    events: [
      { at: REAL_SEQUENCE_DISCONNECT_AT, type: "device.status", payload: REAL_DISCONNECT_FIRST },
      { at: REAL_SEQUENCE_DISCONNECT_AT + 30, type: "device.status", payload: REAL_DISCONNECT_REMOVED },
      { at: REAL_SEQUENCE_RECONNECT_AT, type: "plugin.alive" },
      { at: REAL_SEQUENCE_RECONNECT_AT + 500, type: "device.status", payload: REAL_RECONNECT },
    ],
  });

  const redrawn = replay.sentAfter(REAL_SEQUENCE_RECONNECT_AT);
  // Drawn at plugin.alive, and once more after the "connected" grace period
  // (the order the host normally uses avoids this second draw).
  assert.deepEqual(redrawn.map((result) => result.at - REAL_SEQUENCE_RECONNECT_AT), [0, 0, 0, 2_100, 2_100, 2_100]);
  assert.equal(replay.results.some((result) => result.status === DRAW_RESULT.DISCONNECTED && result.at >= REAL_SEQUENCE_RECONNECT_AT), false);
});

test("plugin backend sends host calls only through the safe wrappers", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "plugin.js"), "utf8");

  assert.equal(source.match(/plugin\.draw\(/g).length, 1, "only keyDrawCache may call plugin.draw");
  assert.match(source, /createKeyDrawCache\(\{\s*draw: \(serialNumber, key, type, base64\) => plugin\.draw\(/);
  assert.match(source, /installUnhandledRejectionGuard\(process/);
  for (const call of ["showFlexbarSnackbarMessage", "showSnackbarMessage", "setConfig", "getConfig"]) {
    const pattern = new RegExp(`(?<!=> )plugin\\.${call}\\(`);
    assert.doesNotMatch(source, pattern, `plugin.${call}() must be wrapped in callHost`);
  }
  assert.doesNotMatch(source, /setInterval\(refreshSnapshot,/);
  // getConfig()/setConfig() have no SDK timeout: nothing may wait for them unbounded.
  assert.match(source, /HOST_CONFIG_SAVE_TIMEOUT_MS\s*\)/, "setConfig() must be called with a timeout");
  assert.equal(source.match(/await ensureHostPluginConfigSynced\(\)/g).length, 1, "only ui.message awaits the config sync directly");
  assert.match(source, /plugin\.on\("plugin\.alive"[\s\S]*?ensureHostPluginConfigSynced\(\);\s*handleKeysLoaded\(payload\);\s*await configSynced;/);
});

// Loads src/plugin.js in a child process against a fake SDK (and collectors
// that always fail, so keys stay on "loading"), replays timed host events and
// prints every plugin.draw() call.
const FAKE_SDK_HOST = `
"use strict";
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = process.env.PLUGIN_ROOT;
const scenario = JSON.parse(process.env.SCENARIO);
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-ai-dashboard-test-"));
const handlers = {};
const draws = [];
let start = 0;
const elapsed = () => Date.now() - start;

function fake(request, exports) {
  const filename = require.resolve(request, { paths: [path.join(root, "src")] });
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };
fake("@eniac/flexdesigner", {
  logger: silent,
  plugin: {
    directory: pluginDir,
    on(type, handler) { handlers[type] = handler; },
    start() {},
    draw(serialNumber, key, type) {
      draws.push({ at: elapsed(), uid: key.uid, type });
      return Promise.resolve({});
    },
    // The SDK sends getConfig() with timeout 0: a silent host never settles it.
    getConfig: () => (scenario.answerConfig ? Promise.resolve({}) : new Promise(() => {})),
    setConfig: () => Promise.resolve({}),
  },
});
fake(path.join(root, "src", "collectors", "snapshot.js"), {
  collectAiSnapshot: async () => { throw new Error("no collectors in tests"); },
  compactSnapshot: (snapshot) => snapshot,
});

// Load the canvas module and system fonts before the clock starts.
require(path.join(root, "src", "dashboard", "render.js")).renderNewSessionKey({ project: "warm-up" }, { width: 240 });
require(path.join(root, "src", "plugin.js"));
start = Date.now();
for (const step of scenario.steps) {
  setTimeout(() => handlers[step.event](step.payload), step.at);
}
setTimeout(() => {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ draws }));
  process.exit(0);
}, scenario.endAt);
`;

function runFakeSdkHost(scenario) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", FAKE_SDK_HOST], {
      encoding: "utf8",
      env: { ...process.env, PLUGIN_ROOT: path.join(__dirname, ".."), SCENARIO: JSON.stringify(scenario) },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

const FAKE_UUID = "com.aspen.flexbar-ai-dashboard";
const aliveOnRealDevice = {
  serialNumber: REAL_SERIAL,
  keys: [
    { uid: 1, cid: `${FAKE_UUID}.session`, width: 240, title: "x", style: {}, data: { sessionTitleMode: "initial" } },
    { uid: 2, cid: `${FAKE_UUID}.plan-usage`, width: 240, title: "x", style: {}, data: {} },
    { uid: 7, cid: `${FAKE_UUID}.new-session`, width: 240, title: "x", style: {}, data: { projectPath: "/tmp/demo" } },
  ],
};
const PLUGIN_RECONNECT_AT = 600;
const pluginReconnectSteps = [
  { at: 0, event: "plugin.alive", payload: aliveOnRealDevice },
  { at: 300, event: "device.status", payload: REAL_DISCONNECT_FIRST },
  { at: 330, event: "device.status", payload: REAL_DISCONNECT_REMOVED },
  { at: PLUGIN_RECONNECT_AT, event: "device.status", payload: REAL_RECONNECT },
];
let fakeSdkRuns = null;
// The three child processes run in parallel; each test awaits its own.
function fakeSdkRun(name) {
  fakeSdkRuns ??= {
    silentConfig: runFakeSdkHost({
      answerConfig: false,
      endAt: 500,
      steps: [{ at: 0, event: "plugin.alive", payload: aliveOnRealDevice }],
    }),
    reconnect: runFakeSdkHost({
      answerConfig: true,
      endAt: 2_900,
      steps: [...pluginReconnectSteps, { at: PLUGIN_RECONNECT_AT + 500, event: "plugin.alive", payload: aliveOnRealDevice }],
    }),
    reconnectWithoutAlive: runFakeSdkHost({ answerConfig: true, endAt: 2_900, steps: pluginReconnectSteps }),
  };
  return fakeSdkRuns[name];
}

test("plugin backend draws loaded keys at once even if the host never answers getConfig", async () => {
  const { draws } = await fakeSdkRun("silentConfig");
  for (const uid of [1, 2, 7]) {
    const first = draws.find((item) => item.uid === uid);
    assert.ok(first, `key ${uid} was never drawn: ${JSON.stringify(draws)}`);
    assert.ok(first.at < 300, `key ${uid} first drawn after ${first.at}ms`);
  }
});

test("plugin backend redraws each key once, right at plugin.alive, after a real replug", async () => {
  const { draws } = await fakeSdkRun("reconnect");
  assert.deepEqual(draws.filter((item) => item.at < PLUGIN_RECONNECT_AT).map((item) => item.uid).sort(), [1, 2, 7]);
  const redrawn = draws.filter((item) => item.at >= PLUGIN_RECONNECT_AT);
  assert.deepEqual(redrawn.map((item) => item.uid).sort(), [1, 2, 7], JSON.stringify(draws));
  for (const item of redrawn) {
    const delay = item.at - PLUGIN_RECONNECT_AT;
    assert.ok(delay >= 500 && delay < 900, `key ${item.uid} redrawn ${delay}ms after the reconnect`);
  }
});

test("plugin backend redraws a replugged device after the grace period without plugin.alive", async () => {
  const { draws } = await fakeSdkRun("reconnectWithoutAlive");
  const redrawn = draws.filter((item) => item.at >= PLUGIN_RECONNECT_AT);
  assert.deepEqual(redrawn.map((item) => item.uid).sort(), [1, 2, 7], JSON.stringify(draws));
  for (const item of redrawn) {
    const delay = item.at - PLUGIN_RECONNECT_AT;
    assert.ok(delay >= DEFAULT_RELOAD_GRACE_MS - 50 && delay < DEFAULT_RELOAD_GRACE_MS + 900, `key ${item.uid} redrawn ${delay}ms after the reconnect`);
  }
});
