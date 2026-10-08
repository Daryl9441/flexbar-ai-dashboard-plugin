"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { DOTS_FACE, buildDotsFace, dotsStatusSummary, formatAge } = require("../src/dashboard/dotsView");
const { t } = require("../src/dashboard/i18n");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function dot(id, overrides = {}) {
  return { id, name: `Dot ${id}`, available: true, paused: false, safety: false, unread: false, latestAt: null, lastCheckInAt: null, ...overrides };
}

function network(dots, activity = {}, extra = {}) {
  return { dots, activity, noAccess: false, at: NOW - MINUTE, ...extra };
}

function state(changes = {}) {
  return { source: "auto", network: null, cache: null, error: null, signedOut: null, ...changes };
}

const face = (value, options = {}) => buildDotsFace(value, { now: NOW, language: "en", ...options });

test("state priority: safety > update > working > paused > idle", () => {
  const all = [
    dot("s", { safety: true }),
    dot("u", { unread: true }),
    dot("w"),
    dot("p", { paused: true }),
    dot("i"),
  ];
  const activity = { w: 2 };
  const expected = [
    [DOTS_FACE.SAFETY, "orange"],
    [DOTS_FACE.UPDATE, "green"],
    [DOTS_FACE.WORKING, "blue"],
    [DOTS_FACE.PAUSED, "gray"],
    [DOTS_FACE.IDLE, "gray"],
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const dots = all.slice(index);
    const result = face(state({ network: network(dots, activity) }));
    assert.deepEqual([result.kind, result.color], expected[index], dots.map((item) => item.id).join(","));
    assert.equal(result.hollow, false);
    assert.equal(result.paused, expected[index][0] === DOTS_FACE.PAUSED);
  }
});

test("a paused dot that still runs a delegated task shows as working", () => {
  const result = face(state({ network: network([dot("a", { paused: true })], { a: 1 }) }));
  assert.equal(result.kind, DOTS_FACE.WORKING);
});

test("several dots in the leading state are counted as ×n", () => {
  const dots = [dot("a", { unread: true }), dot("b", { unread: true }), dot("c")];
  const result = face(state({ network: network(dots) }));
  assert.equal(result.kind, DOTS_FACE.UPDATE);
  assert.equal(result.count, 2);
  assert.equal(result.title, "Update ×2");
  assert.equal(result.detail, "3 dots");

  const zh = buildDotsFace(state({ network: network(dots) }), { now: NOW, language: "zh" });
  assert.equal(zh.title, "有新进展 ×2");
  assert.equal(zh.detail, "3 个 dot");
});

test("one dot shows its name unless the key hides names", () => {
  const one = state({ network: network([dot("a", { unread: true, latestAt: NOW - 3 * MINUTE })]) });
  assert.equal(face(one).title, "Update");
  assert.equal(face(one).detail, "Dot a");
  assert.equal(face(one, { showName: false }).detail, "3m ago");

  const idle = state({ network: network([dot("a", { lastCheckInAt: NOW - 2 * HOUR })]) });
  assert.equal(face(idle).detail, "Dot a");
  assert.equal(face(idle, { showName: false }).detail, "Check-in 2h ago");
  assert.equal(buildDotsFace(idle, { now: NOW, language: "zh", showName: false }).detail, "签到 2小时前");

  const unnamed = state({ network: network([dot("a", { name: null })], { a: 1 }) });
  assert.equal(face(unnamed).title, "Working");
  assert.equal(face(unnamed).detail, "1 dot");
});

test("unavailable dots are ignored; none left means 'no dot'", () => {
  const result = face(state({ network: network([dot("x", { available: false, unread: true })]) }));
  assert.deepEqual([result.kind, result.title, result.detail, result.color], [DOTS_FACE.NONE, "No dot", "Tap to create one", "gray"]);
  assert.equal(face(state({ network: network([]) })).kind, DOTS_FACE.NONE);

  const denied = face(state({ network: network([], {}, { noAccess: true, at: NOW - HOUR }) }));
  assert.deepEqual([denied.kind, denied.title, denied.hollow], [DOTS_FACE.NONE, "Not available", false]);
});

test("loading and signed-out faces", () => {
  const loading = face(state());
  assert.deepEqual([loading.kind, loading.title, loading.hollow], [DOTS_FACE.LOADING, "Loading...", true]);
  assert.equal(face(null).kind, DOTS_FACE.LOADING);

  const signedOut = face(state({ signedOut: "missing", cache: { dots: [dot("a")], activity: {}, updatedAt: NOW } }));
  assert.deepEqual([signedOut.kind, signedOut.title, signedOut.detail], [DOTS_FACE.SIGNED_OUT, "Sign in", "Sign in to the ChatGPT app"]);
});

test("before the first answer the app's cache is shown, hollow and marked as cache", () => {
  const cache = { dots: [dot("a", { paused: true })], activity: {}, updatedAt: NOW - 8 * MINUTE };
  const result = face(state({ cache }));
  assert.equal(result.kind, DOTS_FACE.PAUSED);
  assert.equal(result.hollow, true);
  assert.equal(result.source, "cache");
  assert.equal(result.detail, "Dot a · Cache 8m");
  assert.equal(face(state({ cache }), { showName: false }).detail, "Cache 8m");
});

test("a failed request keeps the last answer unless the cache's data is newer, with the reason", () => {
  const cache = { dots: [dot("a", { paused: true })], activity: { a: 1 }, updatedAt: NOW - 5 * MINUTE };
  const older = network([dot("a")], {}, { at: NOW - 20 * MINUTE });
  const reasons = [
    ["network", "Offline"],
    ["server", "Offline"],
    ["badResponse", "Offline"],
    ["blocked", "Blocked"],
    ["authExpired", "Sign-in expired"],
    ["authRejected", "Sign-in expired"],
    ["rateLimited", "Rate limited"],
  ];
  for (const [category, label] of reasons) {
    const result = face(state({ network: older, cache, error: { category, at: NOW } }));
    assert.equal(result.kind, DOTS_FACE.WORKING, "the app's data (5 min) is newer than the answer (20 min)");
    assert.equal(result.hollow, true);
    assert.equal(result.detail, `${label} · Cache 5m`, category);
    assert.equal(result.source, "cache");
  }

  const newer = network([dot("a", { unread: true })], {}, { at: NOW - 2 * MINUTE });
  const kept = face(state({ network: newer, cache, error: { category: "network", at: NOW } }));
  assert.deepEqual([kept.kind, kept.hollow, kept.detail, kept.source], [DOTS_FACE.UPDATE, true, "Offline · 2m ago", "network"]);
  const zh = buildDotsFace(state({ network: newer, error: { category: "rateLimited", at: NOW } }), { now: NOW, language: "zh" });
  assert.equal(zh.detail, "限流 · 2分钟前");
});

test("one failed request does not swap a newer answer for older cached data", () => {
  // Two dots, one with an unread update, answered 3 minutes ago; the next request timed out. The app's cache holds
  // only the primary dot, without its room, as of 89 minutes ago (however recently the file itself was written).
  const answer = network([dot("a", { unread: true }), dot("b")], {}, { at: NOW - 3 * MINUTE });
  const cache = { dots: [dot("a")], activity: {}, updatedAt: NOW - 89 * MINUTE };
  const result = face(state({ network: answer, cache, error: { category: "network", at: NOW - 30_000 } }));
  assert.deepEqual(
    [result.kind, result.color, result.hollow, result.detail, result.source, result.updatedAt],
    [DOTS_FACE.UPDATE, "green", true, "Offline · 3m ago", "network", NOW - 3 * MINUTE]
  );

  const undated = face(state({ network: answer, cache: { ...cache, updatedAt: null }, error: { category: "network", at: NOW } }));
  assert.deepEqual([undated.kind, undated.source], [DOTS_FACE.UPDATE, "network"], "a cache of unknown age never wins");
});

test("a cache of unknown age says 'Cache' without an age", () => {
  const cache = { dots: [dot("a")], activity: {}, updatedAt: null };
  const offline = face(state({ cache, error: { category: "network", at: NOW } }));
  assert.deepEqual([offline.kind, offline.detail, offline.source, offline.updatedAt], [DOTS_FACE.IDLE, "Offline · Cache", "cache", null]);
  assert.equal(face(state({ source: "local", cache })).detail, "Dot a · Cache");
  assert.equal(buildDotsFace(state({ source: "local", cache }), { now: NOW, language: "zh", showName: false }).detail, "缓存");
});

test("a failure with nothing to show says why, in gray", () => {
  const expired = face(state({ error: { category: "authExpired", at: NOW } }));
  assert.deepEqual(
    [expired.kind, expired.title, expired.detail, expired.color, expired.hollow],
    [DOTS_FACE.DEGRADED, "Sign-in expired", "Open ChatGPT to refresh", "gray", true]
  );
  const offline = face(state({ error: { category: "network", at: NOW } }));
  assert.deepEqual([offline.title, offline.detail], ["Offline", "Retrying later"]);
});

test("an answer older than 10 minutes without a newer error is shown as stale", () => {
  const fresh = face(state({ network: network([dot("a")], {}, { at: NOW - 9 * MINUTE }) }), { showName: false });
  assert.equal(fresh.hollow, false);
  const stale = face(state({ network: network([dot("a")], {}, { at: NOW - 12 * MINUTE }) }), { showName: false });
  assert.equal(stale.hollow, true);
  assert.equal(stale.detail, "12m ago");
});

test("local mode shows only the cache, or says it has none", () => {
  const cache = { dots: [dot("a")], activity: {}, updatedAt: NOW - 2 * HOUR };
  const fromCache = face(state({ source: "local", cache, network: network([dot("a", { unread: true })]) }));
  assert.deepEqual([fromCache.kind, fromCache.hollow, fromCache.detail], [DOTS_FACE.IDLE, true, "Dot a · Cache 2h"]);

  const empty = face(state({ source: "local" }));
  assert.deepEqual([empty.kind, empty.title, empty.detail], [DOTS_FACE.DEGRADED, "No local data", "Open ChatGPT to refresh"]);
  const noDot = face(state({ source: "local", cache: { dots: [], activity: {}, updatedAt: NOW } }));
  assert.equal(noDot.kind, DOTS_FACE.NONE);
  assert.equal(noDot.hollow, true);
});

test("formatAge is compact in both languages", () => {
  assert.equal(formatAge(20_000, "en"), "<1m");
  assert.equal(formatAge(5 * MINUTE, "en"), "5m");
  assert.equal(formatAge(90 * MINUTE, "en"), "1h");
  assert.equal(formatAge(50 * HOUR, "en"), "2d");
  assert.equal(formatAge(5 * MINUTE, "zh"), "5分钟");
  assert.equal(formatAge(-5, "en"), "<1m");
});

test("the settings-page summary holds the state, the source and a time only", () => {
  const summary = dotsStatusSummary(state({ network: network([dot("tbo~secret", { name: "Secret Name", unread: true })]) }), { now: NOW });
  assert.deepEqual(summary, { state: DOTS_FACE.UPDATE, degraded: false, source: "network", updatedAt: NOW - MINUTE });
  assert.deepEqual(dotsStatusSummary(null, { now: NOW }), { state: DOTS_FACE.LOADING, degraded: true, source: null, updatedAt: null });
});

test("every Dots string exists in both languages and snackbar texts fit the host limit", () => {
  const keys = [
    "dotsLabel", "dotsLoading", "dotsWorking", "dotsUpdate", "dotsSafety", "dotsPaused", "dotsIdle", "dotsNone",
    "dotsCreate", "dotsUnavailable", "dotsUnavailableHint", "dotsSignIn", "dotsSignInHint", "dotsOffline",
    "dotsAuthExpired", "dotsRateLimited", "dotsBlocked", "dotsRetrying", "dotsOpenAppHint", "dotsNoCache",
    "dotsCached", "dotsCachedUndated", "dotsAgo", "dotsCheckIn", "dotsCount", "dotsCountOne", "dotsAgeNow", "dotsAgeMinutes",
    "dotsAgeHours", "dotsAgeDays", "dotsOpening", "dotsOpenedWeb", "dotsOpenFailed",
  ];
  for (const language of ["en", "zh"]) {
    for (const key of keys) {
      const text = t(language, key);
      assert.notEqual(text, key, `${language}.${key}`);
      assert.ok(text.trim(), `${language}.${key}`);
    }
    for (const key of ["dotsOpening", "dotsOpenedWeb", "dotsOpenFailed"]) assert.ok(t(language, key).length <= 63, key);
  }
  assert.notEqual(t("zh", "dotsWorking"), t("en", "dotsWorking"));
});
