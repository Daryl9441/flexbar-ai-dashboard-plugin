"use strict";

const { spawnSync } = require("node:child_process");
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
} = require("../src/dashboard/hostSafety");
const { DRAW_RESULT, createKeyDrawCache } = require("../src/dashboard/keyDrawCache");
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
  // Unchanged content is still redrawn: the device screen was reset.
  assert.equal(await cache.drawKey("SN1", key(2), "base64", "img-2"), DRAW_RESULT.DRAWN);
  assert.equal(await cache.drawKey("SN1", key(1), "base64", "img-1-9"), DRAW_RESULT.DRAWN);
  assert.equal(host.calls.length, 5);
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

test("device status adapter normalizes FlexDesigner device.status payloads", () => {
  assert.deepEqual(extractDeviceStatuses([
    { serialNumber: "001100AA0001", status: "connected", deviceData: { model: "Flexbar" } },
  ]), [{ serialNumber: "001100AA0001", status: "connected" }]);
  assert.deepEqual(extractDeviceStatuses([
    { serialNumber: "001100AA0001", status: "disconnected", _removeDevice: true },
  ]), [{ serialNumber: "001100AA0001", status: "disconnected" }]);
  assert.deepEqual(extractDeviceStatuses({ serialNumber: "s1", status: "Connected" }), [
    { serialNumber: "s1", status: "connected" },
  ]);
  assert.deepEqual(extractDeviceStatuses({ devices: [{ serialNumber: "s1", _removeDevice: true }] }), [
    { serialNumber: "s1", status: "disconnected" },
  ]);
  assert.deepEqual(extractDeviceStatuses([{ serialNumber: "s1", status: "updating" }, { status: "connected" }, null]), []);
  assert.deepEqual(extractDeviceStatuses(null), []);
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
});
