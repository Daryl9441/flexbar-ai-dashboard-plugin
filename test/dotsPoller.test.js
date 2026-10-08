"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_TIMING, createDotsPoller } = require("../src/collectors/dotsPoller");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 9, 8, 12, 0, 0);
const FAKE_TOKEN = ["ey", "J", "a".repeat(30), ".", "b".repeat(40), ".", "c".repeat(20)].join("");
const FAKE_ACCOUNT = "acct-" + "0".repeat(8);
const DOT_NAME = "Test Dot";

function dot(id, overrides = {}) {
  return { id, name: DOT_NAME, available: true, paused: false, safety: false, unread: false, latestAt: null, lastCheckInAt: null, ...overrides };
}

function credentials({ expiresAt = START + 10 * 24 * HOUR } = {}) {
  const value = { ok: true, expiresAt, hasAccountId: true };
  Object.defineProperties(value, {
    accessToken: { value: FAKE_TOKEN, enumerable: false },
    accountId: { value: FAKE_ACCOUNT, enumerable: false },
  });
  return value;
}

// Timers that only fire when the test advances the clock; rounds are async, so each fired timer is followed by a
// flush of pending promises.
function fakeClock() {
  let time = START;
  let sequence = 0;
  const timers = new Map();
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => time,
    setTimer(fn, ms) {
      sequence += 1;
      timers.set(sequence, { at: time + Math.max(0, ms), fn });
      return sequence;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending() {
      return [...timers.values()].map((timer) => timer.at - time).sort((a, b) => a - b);
    },
    flush,
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

// A client that answers from `script` (functions of the call) and reports one request event per call, like the
// real one does through onRequest.
function harness(options = {}) {
  const clock = fakeClock();
  const calls = [];
  const logs = [];
  const updates = [];
  let config = { codexHome: "/Users/me/.codex", statusSource: "auto", ...(options.config || {}) };
  let creds = options.credentials || credentials();
  let cacheReads = 0;
  const listAnswer = options.list || (() => ({ ok: true, dots: [dot("tbo~test-0001")] }));
  const activityAnswer = options.activity || (() => ({ ok: true, inProgress: 0 }));
  let poller = null;
  const client = {
    async fetchList() {
      calls.push({ kind: "list", at: clock.now() });
      poller.recordRequest({ kind: "list", route: "system-proxy", status: 200, category: null });
      return options.listAsync ? options.listAsync() : listAnswer(calls.length);
    },
    async fetchActivity(_credentials, id) {
      calls.push({ kind: "activity", id, at: clock.now() });
      poller.recordRequest({ kind: "activity", route: "system-proxy", status: 200, category: null });
      return activityAnswer(id);
    },
  };
  const log = {
    info: (...args) => logs.push(args),
    warn: (...args) => logs.push(args),
    error: (...args) => logs.push(args),
  };
  poller = createDotsPoller({
    client,
    readCredentials: () => creds,
    readCache: () => {
      cacheReads += 1;
      return options.cache === undefined ? null : options.cache;
    },
    getConfig: () => config,
    onUpdate: (state) => updates.push(state),
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: options.random || (() => 0.5),
    timing: options.timing,
  });
  return {
    clock,
    calls,
    logs,
    updates,
    poller,
    lists: () => calls.filter((call) => call.kind === "list"),
    setConfig: (next) => {
      config = { ...config, ...next };
    },
    setCredentials: (next) => {
      creds = next;
    },
    cacheReads: () => cacheReads,
  };
}

test("starting runs a round at once, then about every 150 s with ±10% jitter", async () => {
  const low = harness({ random: () => 0 });
  await low.poller.start();
  assert.deepEqual(low.calls.map((call) => call.kind), ["list", "activity"]);
  assert.equal(low.poller.getState().network.dots.length, 1);
  assert.equal(low.updates.length, 1);
  assert.deepEqual(low.clock.pending(), [135_000]);

  const high = harness({ random: () => 0.999999 });
  await high.poller.start();
  assert.ok(Math.abs(high.clock.pending()[0] - 165_000) < 10);

  const mid = harness();
  await mid.poller.start();
  assert.deepEqual(mid.clock.pending(), [DEFAULT_TIMING.intervalMs]);
  await mid.clock.advance(150_000);
  assert.equal(mid.lists().length, 2);
});

test("the interval stretches with the number of dots and activity rotates through them, paused ones included", async () => {
  const ids = ["tbo~a", "tbo~b", "tbo~c"];
  const h = harness({
    list: () => ({ ok: true, dots: [dot(ids[0]), dot(ids[1], { paused: true }), dot(ids[2]), dot("tbo~gone", { available: false })] }),
  });
  await h.poller.start();
  assert.deepEqual(h.clock.pending(), [150_000 * 1.5], "3 available dots: 1.5x");
  await h.clock.advance(225_000 * 3);
  assert.deepEqual(h.calls.filter((call) => call.kind === "activity").map((call) => call.id), ["tbo~a", "tbo~b", "tbo~c", "tbo~a"]);

  const many = harness({ list: () => ({ ok: true, dots: Array.from({ length: 12 }, (_, index) => dot(`tbo~${index}`)) }) });
  await many.poller.start();
  assert.deepEqual(many.clock.pending(), [300_000], "capped at 2x");
});

test("activity results are kept per dot and dropped for dots that disappear", async () => {
  let dots = [dot("tbo~a"), dot("tbo~b")];
  const h = harness({ list: () => ({ ok: true, dots }), activity: (id) => ({ ok: true, inProgress: id === "tbo~a" ? 2 : 0 }) });
  await h.poller.start();
  await h.clock.advance(225_000);
  assert.deepEqual(h.poller.getState().network.activity, { "tbo~a": 2, "tbo~b": 0 });
  dots = [dot("tbo~b")];
  await h.clock.advance(225_000);
  assert.deepEqual(h.poller.getState().network.activity, { "tbo~b": 0 });
});

test("only one round runs at a time; a refresh asked for meanwhile runs once afterwards", async () => {
  let release;
  let pending = true;
  const h = harness({
    listAsync: () => (pending ? new Promise((resolve) => {
      release = () => {
        pending = false;
        resolve({ ok: true, dots: [dot("tbo~a")] });
      };
    }) : Promise.resolve({ ok: true, dots: [dot("tbo~a")] })),
  });
  const first = h.poller.start();
  await h.clock.flush();
  h.poller.requestRefresh([0]);
  h.poller.refreshNow();
  await h.clock.advance(0);
  assert.equal(h.lists().length, 1, "no second request while the first is in flight");
  release();
  await first;
  await h.clock.advance(0);
  assert.equal(h.lists().length, 2, "exactly one catch-up round");
});

test("network failures back off exponentially up to 15 minutes; success resets the interval", async () => {
  let fail = true;
  const h = harness({ list: () => (fail ? { ok: false, category: "network", status: null, retryAfterMs: null } : { ok: true, dots: [dot("tbo~a")] }) });
  await h.poller.start();
  const gaps = [];
  for (let index = 0; index < 5; index += 1) {
    const before = h.lists().length;
    const startAt = h.clock.now();
    while (h.lists().length === before) await h.clock.advance(10_000);
    gaps.push(h.lists().at(-1).at - startAt);
  }
  assert.deepEqual(gaps.map((gap) => Math.round(gap / 10_000) * 10_000), [150_000, 300_000, 600_000, 900_000, 900_000]);
  assert.equal(h.poller.getState().error.category, "network");
  assert.ok(!h.calls.some((call) => call.kind === "activity"));

  fail = false;
  await h.clock.advance(900_000);
  assert.equal(h.poller.getState().error, null);
  const after = h.lists().length;
  await h.clock.advance(150_000);
  assert.equal(h.lists().length, after + 1, "back to the normal interval");
});

test("rounds keep reading the local cache while the network is backing off", async () => {
  const h = harness({ list: () => ({ ok: false, category: "network", status: null, retryAfterMs: null }), cache: { dots: [], activity: {}, updatedAt: START } });
  await h.poller.start();
  const reads = h.cacheReads();
  await h.clock.advance(120_000);
  assert.ok(h.cacheReads() >= reads + 3, "the cache is re-read about every 30 s");
  assert.equal(h.lists().length, 1);
});

test("429 waits for Retry-After, or 15 minutes without it", async () => {
  const withHeader = harness({ list: (n) => (n === 1 ? { ok: false, category: "rateLimited", status: 429, retryAfterMs: 400_000 } : { ok: true, dots: [] }) });
  await withHeader.poller.start();
  await withHeader.clock.advance(399_000);
  assert.equal(withHeader.lists().length, 1);
  await withHeader.clock.advance(31_000);
  assert.equal(withHeader.lists().length, 2);

  const without = harness({ list: () => ({ ok: false, category: "rateLimited", status: 429, retryAfterMs: null }) });
  await without.poller.start();
  await without.clock.advance(14 * MINUTE);
  assert.equal(without.lists().length, 1);
  await without.clock.advance(MINUTE + 30_000);
  assert.equal(without.lists().length, 2);
  assert.equal(without.poller.getState().error.category, "rateLimited");
});

test("a 401 before the token's exp is a rejection: re-checked after 30 minutes, or as soon as the token changes", async () => {
  const h = harness({ list: (n) => (n === 1 ? { ok: false, category: "authRejected", status: 401, retryAfterMs: null } : { ok: true, dots: [dot("tbo~a")] }) });
  await h.poller.start();
  assert.equal(h.poller.getState().error.category, "authRejected");
  await h.clock.advance(29 * MINUTE);
  assert.equal(h.lists().length, 1);
  await h.clock.advance(2 * MINUTE);
  assert.equal(h.lists().length, 2);

  const refreshed = harness({ list: (n) => (n === 1 ? { ok: false, category: "authRejected", status: 401, retryAfterMs: null } : { ok: true, dots: [] }) });
  await refreshed.poller.start();
  refreshed.setCredentials(credentials({ expiresAt: START + 11 * 24 * HOUR }));
  await refreshed.clock.advance(31_000);
  assert.equal(refreshed.lists().length, 2, "a new token (new exp) lifts the wait");
});

test("an activity 429 waits for Retry-After before any request, the list included", async () => {
  const h = harness({ activity: () => ({ ok: false, category: "rateLimited", status: 429, retryAfterMs: 600_000 }) });
  await h.poller.start();
  assert.deepEqual(h.calls.map((call) => call.kind), ["list", "activity"]);
  assert.equal(h.poller.getState().error.category, "rateLimited");
  assert.equal(h.poller.getState().network.dots.length, 1, "the list answer is kept");
  await h.clock.advance(599_000);
  assert.equal(h.calls.length, 2, "nothing for 10 minutes");
  await h.clock.advance(31_000);
  assert.equal(h.lists().length, 2);
});

test("an activity 401 before the token's exp waits 30 minutes, or until the token changes", async () => {
  const rejected = { ok: false, category: "authRejected", status: 401, retryAfterMs: null };
  const h = harness({ activity: () => rejected });
  await h.poller.start();
  assert.equal(h.poller.getState().error.category, "authRejected");
  await h.clock.advance(29 * MINUTE);
  assert.equal(h.calls.length, 2, "nothing for 30 minutes");
  await h.clock.advance(2 * MINUTE);
  assert.equal(h.lists().length, 2);

  const refreshed = harness({ activity: (id) => (refreshed.calls.filter((call) => call.kind === "activity").length === 1 ? rejected : { ok: true, inProgress: 0 }) });
  await refreshed.poller.start();
  refreshed.setCredentials(credentials({ expiresAt: START + 11 * 24 * HOUR }));
  await refreshed.clock.advance(31_000);
  assert.equal(refreshed.lists().length, 2, "a new token (new exp) lifts the wait at the next 30 s check");
  assert.equal(refreshed.poller.getState().error, null);
});

test("any other activity failure keeps the list answer and the normal interval", async () => {
  const h = harness({ activity: () => ({ ok: false, category: "network", status: null, retryAfterMs: null }) });
  await h.poller.start();
  assert.equal(h.poller.getState().error, null);
  assert.deepEqual(h.poller.getState().network.activity, {});
  assert.deepEqual(h.clock.pending(), [150_000]);
});

test("an expired token is never sent; the key falls back to the cache until the app refreshes it", async () => {
  const cache = { dots: [dot("tbo~a")], activity: {}, updatedAt: START - MINUTE };
  const h = harness({ credentials: credentials({ expiresAt: START - 1_000 }), cache });
  await h.poller.start();
  await h.clock.advance(10 * MINUTE);
  assert.equal(h.calls.length, 0);
  assert.equal(h.poller.getState().error.category, "authExpired");
  assert.deepEqual(h.poller.getState().cache, cache);

  h.setCredentials(credentials({ expiresAt: START + 24 * HOUR }));
  await h.clock.advance(31_000);
  assert.equal(h.lists().length, 1);
  assert.equal(h.poller.getState().error, null);
});

test("JSON 403/404 means no Dots on this account and is re-checked every 30 minutes", async () => {
  const h = harness({ list: () => ({ ok: false, category: "noAccess", status: 403, retryAfterMs: null }) });
  await h.poller.start();
  assert.equal(h.poller.getState().error, null);
  assert.deepEqual(h.poller.getState().network.dots, []);
  assert.equal(h.poller.getState().network.noAccess, true);
  await h.clock.advance(29 * MINUTE);
  assert.equal(h.lists().length, 1);
  await h.clock.advance(MINUTE + 30_000);
  assert.equal(h.lists().length, 2);
});

test("no more than 60 requests in any hour, however often the key is pressed", async () => {
  const h = harness();
  await h.poller.start();
  for (let minute = 0; minute < 120; minute += 1) {
    h.poller.requestRefresh([20_000, 90_000]);
    await h.clock.advance(MINUTE);
  }
  const times = h.calls.map((call) => call.at);
  for (const at of times) {
    const inHour = times.filter((other) => other >= at && other < at + HOUR).length;
    assert.ok(inHour <= 60, `${inHour} requests in the hour from ${at - START}`);
  }
  assert.ok(times.length > 60, "it keeps polling once the hour has passed");
  assert.ok(h.logs.some((args) => /budget/.test(String(args[0]))), "the skipped requests are logged");
});

test("the activity request leaves one request of the budget for the next list", async () => {
  const h = harness({ timing: { budgetPerHour: 3 } });
  await h.poller.start();
  await h.clock.advance(150_000);
  assert.deepEqual(h.calls.map((call) => call.kind), ["list", "activity", "list"]);
});

test("press refreshes run 20 s and 90 s later but respect a backoff", async () => {
  const h = harness();
  await h.poller.start();
  h.poller.requestRefresh([20_000, 90_000]);
  await h.clock.advance(20_000);
  assert.equal(h.lists().length, 2);
  await h.clock.advance(70_000);
  assert.equal(h.lists().length, 3);

  const backingOff = harness({ list: () => ({ ok: false, category: "network", status: null, retryAfterMs: null }) });
  await backingOff.poller.start();
  backingOff.poller.requestRefresh([20_000, 90_000]);
  await backingOff.clock.advance(100_000);
  assert.equal(backingOff.lists().length, 1);
});

test("pausing while every device is unplugged stops all timers; resuming catches up", async () => {
  const h = harness();
  await h.poller.start();
  h.poller.requestRefresh([20_000]);
  h.poller.setPaused(true);
  assert.deepEqual(h.clock.pending(), []);
  await h.clock.advance(HOUR);
  assert.equal(h.lists().length, 1);

  await h.poller.setPaused(false);
  assert.equal(h.lists().length, 2, "long away: refreshed at once");

  h.poller.setPaused(true);
  await h.clock.advance(MINUTE);
  await h.poller.setPaused(false);
  assert.equal(h.lists().length, 2, "briefly away: no extra request");
  assert.deepEqual(h.clock.pending(), [90_000]);
});

test("a config change refreshes at once; local mode never touches the network", async () => {
  const h = harness({ cache: { dots: [dot("tbo~a")], activity: {}, updatedAt: START } });
  await h.poller.start();
  assert.equal(h.lists().length, 1);

  h.setConfig({ statusSource: "local" });
  await h.poller.refreshNow();
  await h.clock.advance(3 * HOUR);
  assert.equal(h.lists().length, 1);
  assert.equal(h.poller.getState().source, "local");
  assert.ok(h.cacheReads() > 100, "the cache is still read");

  h.setConfig({ statusSource: "auto" });
  await h.poller.refreshNow();
  assert.equal(h.lists().length, 2);

  const fresh = harness({ config: { statusSource: "local" } });
  await fresh.poller.start();
  await fresh.clock.advance(HOUR);
  assert.equal(fresh.calls.length, 0);
});

test("a new Codex home lifts a sign-in wait, but never a rate limit", async () => {
  const rejected = harness({ list: (n) => (n === 1 ? { ok: false, category: "authRejected", status: 401, retryAfterMs: null } : { ok: true, dots: [] }) });
  await rejected.poller.start();
  await rejected.poller.refreshNow({ resetGates: true });
  assert.equal(rejected.lists().length, 2);

  const limited = harness({ list: () => ({ ok: false, category: "rateLimited", status: 429, retryAfterMs: HOUR }) });
  await limited.poller.start();
  await limited.poller.refreshNow({ resetGates: true });
  assert.equal(limited.lists().length, 1);
});

test("a missing sign-in sends nothing; an unreadable auth.json is retried soon without signing out", async () => {
  const h = harness({ credentials: { ok: false, reason: "missing" } });
  await h.poller.start();
  assert.equal(h.calls.length, 0);
  assert.equal(h.poller.getState().signedOut, "missing");

  const flaky = harness();
  await flaky.poller.start();
  flaky.setCredentials({ ok: false, reason: "unreadable" });
  await flaky.clock.advance(150_000);
  assert.equal(flaky.poller.getState().signedOut, null);
  assert.ok(flaky.poller.getState().network, "the last result is kept");
  flaky.setCredentials(credentials());
  await flaky.clock.advance(30_000);
  assert.equal(flaky.lists().length, 2);
});

test("stop clears every timer; a quick restart does not ask again", async () => {
  const h = harness();
  await h.poller.start();
  h.poller.requestRefresh([20_000, 90_000]);
  h.poller.stop();
  assert.deepEqual(h.clock.pending(), []);
  await h.clock.advance(HOUR);
  assert.equal(h.calls.length, 2);
  assert.equal(h.poller.isRunning(), false);

  const quick = harness();
  await quick.poller.start();
  quick.poller.stop();
  await quick.clock.advance(10_000);
  await quick.poller.start();
  assert.equal(quick.lists().length, 1);
  assert.equal(quick.clock.pending().length, 1);
});

test("quick restarts keep the planned time of the next round instead of pulling it in", async () => {
  const h = harness();
  await h.poller.start();
  const pendingAfter = async (stopAt, startAt) => {
    await h.clock.advance(stopAt - (h.clock.now() - START));
    h.poller.stop();
    await h.clock.advance(startAt - stopAt);
    await h.poller.start();
    return h.clock.pending();
  };
  assert.deepEqual(await pendingAfter(10_000, 20_000), [130_000]);
  assert.deepEqual(await pendingAfter(30_000, 40_000), [110_000]);
  assert.deepEqual(await pendingAfter(50_000, 55_000), [95_000]);
  assert.deepEqual(await pendingAfter(56_000, 59_000), [91_000]);
  assert.equal(h.lists().length, 1);
  await h.clock.advance(90_000);
  assert.equal(h.lists().length, 1, "still nothing before the planned 150 s");
  await h.clock.advance(1_000);
  assert.equal(h.lists().length, 2);
});

test("a restart never runs a round within 60 s of the last one, even when one was due sooner", async () => {
  const h = harness({ list: () => ({ ok: false, category: "network", status: null, retryAfterMs: null }), timing: { intervalMs: 20_000 } });
  await h.poller.start();
  assert.deepEqual(h.clock.pending(), [20_000], "the backoff wait (20 s here) is the next round");
  await h.clock.advance(5_000);
  h.poller.stop();
  await h.clock.advance(5_000);
  await h.poller.start();
  assert.deepEqual(h.clock.pending(), [50_000], "60 s after the last round, not the 10 s left of its plan");
});

test("pausing and resuming twice keeps the planned time of the next round", async () => {
  const h = harness();
  await h.poller.start();
  await h.clock.advance(10_000);
  await h.poller.setPaused(true);
  await h.clock.advance(90_000);
  await h.poller.setPaused(false);
  assert.deepEqual(h.clock.pending(), [50_000]);
  await h.clock.advance(10_000);
  await h.poller.setPaused(true);
  await h.clock.advance(10_000);
  await h.poller.setPaused(false);
  assert.deepEqual(h.clock.pending(), [30_000]);
  await h.clock.advance(29_000);
  assert.equal(h.lists().length, 1, "no round before the planned 150 s");
  await h.clock.advance(1_000);
  assert.equal(h.lists().length, 2);
});

test("restarting while the first round is still in flight does not start a second one", async () => {
  let release;
  const h = harness({
    listAsync: () => new Promise((resolve) => {
      release = () => resolve({ ok: true, dots: [dot("tbo~a")] });
    }),
  });
  const first = h.poller.start();
  await h.clock.flush();
  h.poller.stop();
  await h.poller.start();
  release();
  await first;
  await h.clock.advance(0);
  assert.equal(h.lists().length, 1);
  assert.deepEqual(h.clock.pending(), [150_000], "the finished round plans the next one");
});

test("plugging a Flexbar back in while a round is in flight does not start a second one", async () => {
  let release;
  const h = harness({
    listAsync: () => new Promise((resolve) => {
      release = () => resolve({ ok: true, dots: [dot("tbo~a")] });
    }),
  });
  const first = h.poller.start();
  await h.clock.flush();
  await h.poller.setPaused(true);
  await h.poller.setPaused(false);
  release();
  await first;
  await h.clock.advance(0);
  assert.equal(h.lists().length, 1);
  assert.deepEqual(h.clock.pending(), [150_000]);
});

test("diagnostics and logs hold routes, statuses, categories and counts only", async () => {
  const h = harness({
    list: (n) => (n === 1 ? { ok: true, dots: [dot("tbo~test-0001")] } : { ok: false, category: "authRejected", status: 401, retryAfterMs: null }),
  });
  await h.poller.start();
  assert.deepEqual(h.poller.getDiagnostics(), {
    source: "auto",
    route: "system-proxy",
    list: { status: 200, category: null },
    activity: { status: 200, category: null },
    dots: 1,
    error: null,
  });
  await h.clock.advance(150_000);
  assert.equal(h.poller.getDiagnostics().error, "authRejected");

  const text = JSON.stringify([h.logs, h.poller.getDiagnostics()]);
  for (const secret of [FAKE_TOKEN, FAKE_ACCOUNT, "tbo~test-0001", DOT_NAME]) assert.ok(!text.includes(secret));
});

test("a failing callback or cache reader never breaks the polling", async () => {
  const clock = fakeClock();
  let lists = 0;
  const poller = createDotsPoller({
    client: {
      fetchList: async () => {
        lists += 1;
        return { ok: true, dots: [] };
      },
      fetchActivity: async () => ({ ok: true, inProgress: 0 }),
    },
    readCredentials: () => credentials(),
    readCache: () => {
      throw new Error("boom");
    },
    getConfig: () => ({ codexHome: "/Users/me/.codex" }),
    onUpdate: () => {
      throw new Error("draw failed");
    },
    log: { info() {}, warn() {}, error() {} },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  });
  await poller.start();
  await clock.advance(150_000);
  assert.equal(lists, 2);
  assert.equal(poller.getState().cache, null);
});
