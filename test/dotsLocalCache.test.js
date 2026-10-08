"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { STATE_FILE, createDotsLocalCache } = require("../src/collectors/dotsLocalCache");
const { DOTS_FACE, buildDotsFace } = require("../src/dashboard/dotsView");

const ACCOUNT = "acct-" + "0".repeat(8);
const OTHER_ACCOUNT = "acct-" + "9".repeat(8);
const TBO_ID = "tbo~test-0001";
const DOT_NAME = "Test Dot";
// When the app last had the dot (selection) and when the dot itself last changed (profile): the cache's age comes
// from these, never from the file's mtime (the file is rewritten for hundreds of unrelated atoms).
const SELECTED_AT = "2026-10-08T09:30:00Z";
const PROFILE_UPDATED_AT = "2026-10-08T09:45:00Z";

function primary({ accountId = ACCOUNT, profile = dotProfile() } = {}) {
  return {
    accountId,
    userId: "user-test-0001",
    response: {
      selection: {
        thread_id: "thread-test-0001",
        aeon_id: "aeon-test-0001",
        available: true,
        messaging_room_id: "room-test-0001",
        selected_at: SELECTED_AT,
      },
      profile,
    },
  };
}

function dotProfile(overrides = {}) {
  return {
    id: TBO_ID,
    display_name: DOT_NAME,
    status: "active",
    is_paused: false,
    isSafetyFlagged: false,
    safety_flag: null,
    last_check_in_at: "2026-10-08T10:00:00Z",
    updated_at: PROFILE_UPDATED_AT,
    description: "made-up description",
    ...overrides,
  };
}

function snapshots(entries) {
  return entries.map(({ tboId = TBO_ID, accountId = ACCOUNT, statuses }) => ({
    tboId,
    accountId,
    userId: "user-test-0001",
    data: statuses.map((status) => ({ status, title: "made-up task" })),
  }));
}

function globalState(atoms, { stringify = false } = {}) {
  const encoded = stringify
    ? Object.fromEntries(Object.entries(atoms).map(([key, value]) => [key, JSON.stringify(value)]))
    : atoms;
  return { "electron-persisted-atom-state": stringify ? JSON.stringify(encoded) : encoded, "other-app-state": { big: "x".repeat(100) } };
}

function codexHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-dots-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, value, name = STATE_FILE, mtimeMs = Date.UTC(2026, 9, 8, 11, 0, 0)) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test("the primary dot and its in-progress activity are read from the app's global state", (t) => {
  const home = codexHome(t);
  const mtime = Date.UTC(2026, 9, 8, 11, 0, 0);
  write(home, globalState({
    "primary-aeon-selection-v1": primary(),
    "orbit-activity-snapshots-v1": snapshots([{ statuses: ["in_progress", "completed", null] }]),
  }), STATE_FILE, mtime);

  const cached = createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT });
  assert.deepEqual(cached, {
    dots: [{
      id: TBO_ID,
      name: DOT_NAME,
      available: true,
      paused: false,
      safety: false,
      unread: false,
      latestAt: null,
      lastCheckInAt: Date.parse("2026-10-08T10:00:00Z"),
    }],
    activity: { [TBO_ID]: 1 },
    updatedAt: Date.parse(PROFILE_UPDATED_AT),
  });
  const text = JSON.stringify(cached);
  for (const dropped of ["user-test-0001", "thread-test-0001", "room-test-0001", "made-up description", "made-up task"]) {
    assert.ok(!text.includes(dropped), `${dropped} is not kept`);
  }
});

test("atoms stored as JSON strings are read like objects", (t) => {
  const home = codexHome(t);
  write(home, globalState({
    "primary-aeon-selection-v1": primary({ profile: dotProfile({ is_paused: true }) }),
    "orbit-activity-snapshots-v1": snapshots([{ statuses: ["in_progress", "in_progress"] }]),
  }, { stringify: true }));

  const cached = createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT });
  assert.equal(cached.dots[0].paused, true);
  assert.deepEqual(cached.activity, { [TBO_ID]: 2 });
});

test("activity snapshots keyed by dot id are read too", (t) => {
  const home = codexHome(t);
  write(home, globalState({
    "primary-aeon-selection-v1": primary(),
    "orbit-activity-snapshots-v1": { [TBO_ID]: snapshots([{ statuses: ["in_progress"] }])[0] },
  }));
  assert.deepEqual(createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT }).activity, { [TBO_ID]: 1 });
});

test("a broken state file falls back to the .bak copy", (t) => {
  const home = codexHome(t);
  write(home, "{\"electron-persisted-atom-state\": {");
  const bakTime = Date.UTC(2026, 9, 8, 10, 30, 0);
  write(home, globalState({ "primary-aeon-selection-v1": primary() }), `${STATE_FILE}.bak`, bakTime);

  const cached = createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT });
  assert.equal(cached.dots[0].id, TBO_ID);
  assert.equal(cached.updatedAt, Date.parse(PROFILE_UPDATED_AT), "the age is the backup's data");

  fs.writeFileSync(path.join(home, `${STATE_FILE}.bak`), "also broken");
  const fresh = createDotsLocalCache();
  assert.equal(fresh.read({ codexHome: home, accountId: ACCOUNT }), null);
});

test("the cache's age is its newest Dots timestamp, not the file's mtime, and never later than the file", (t) => {
  const home = codexHome(t);
  const sidebar = (refreshStartedAtMs, accountId = ACCOUNT) => ({ accountId, userId: "user-test-0001", refreshStartedAtMs, threads: [] });
  // The file was rewritten a moment ago for an unrelated atom; the Dots data in it is about two hours old.
  const fileTime = Date.UTC(2026, 9, 8, 11, 59, 30);
  write(home, globalState({
    "primary-aeon-selection-v1": primary(),
    "cloud-aeon-sidebar-cache-v1": sidebar(Date.UTC(2026, 9, 8, 9, 40, 0) + 0.25),
    "unrelated-atom": { changedAt: fileTime },
  }), STATE_FILE, fileTime);
  const cache = createDotsLocalCache();
  assert.equal(cache.read({ codexHome: home, accountId: ACCOUNT }).updatedAt, Date.parse(PROFILE_UPDATED_AT), "the newest of selected_at, updated_at, refreshStartedAtMs");

  write(home, globalState({
    "primary-aeon-selection-v1": primary(),
    "cloud-aeon-sidebar-cache-v1": sidebar(Date.UTC(2026, 9, 8, 10, 15, 0) + 0.4),
  }), STATE_FILE, fileTime + 1_000);
  const refreshed = cache.read({ codexHome: home, accountId: ACCOUNT }).updatedAt;
  assert.equal(refreshed, Date.UTC(2026, 9, 8, 10, 15, 0), "the app's own refresh time counts, as a whole millisecond");
  assert.ok(Number.isInteger(refreshed));

  write(home, globalState({
    "primary-aeon-selection-v1": primary(),
    "cloud-aeon-sidebar-cache-v1": sidebar(Date.UTC(2026, 9, 8, 11, 50, 0), "acct-" + "9".repeat(8)),
  }), STATE_FILE, fileTime + 2_000);
  assert.equal(cache.read({ codexHome: home, accountId: ACCOUNT }).updatedAt, Date.parse(PROFILE_UPDATED_AT), "another account's refresh is ignored");

  write(home, globalState({ "primary-aeon-selection-v1": primary({ profile: dotProfile({ updated_at: "2026-10-08T12:30:00Z" }) }) }), STATE_FILE, fileTime + 3_000);
  assert.equal(cache.read({ codexHome: home, accountId: ACCOUNT }).updatedAt, fileTime + 3_000, "a timestamp ahead of the file is capped at its mtime");

  const bare = primary({ profile: dotProfile({ updated_at: null }) });
  delete bare.response.selection.selected_at;
  write(home, globalState({ "primary-aeon-selection-v1": bare }), STATE_FILE, fileTime + 4_000);
  assert.equal(cache.read({ codexHome: home, accountId: ACCOUNT }).updatedAt, null, "no timestamp: the age is unknown");
});

test("a freshly rewritten state file does not replace the last answer after one failed request", (t) => {
  const home = codexHome(t);
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  // The file was written 10 s ago for an unrelated atom; its Dots data is from about two hours ago.
  write(home, globalState({ "primary-aeon-selection-v1": primary() }), STATE_FILE, now - 10_000);
  const cache = createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT });
  const dot = (id, unread) => ({ id, name: DOT_NAME, available: true, paused: false, safety: false, unread, latestAt: null, lastCheckInAt: null });
  const network = { dots: [dot(TBO_ID, true), dot("tbo~test-0002", false)], activity: {}, noAccess: false, at: now - 150_000 };
  const state = { source: "auto", network, cache, error: { category: "network", at: now - 5_000 }, signedOut: null };

  const face = buildDotsFace(state, { now, language: "en" });
  assert.deepEqual([face.kind, face.hollow, face.detail, face.source], [DOTS_FACE.UPDATE, true, "Offline · 2m ago", "network"]);
  const local = buildDotsFace({ ...state, source: "local" }, { now, language: "en", showName: false });
  assert.equal(local.detail, "Cache 2h", "the cache's own age, not the file's");
});

test("another account's cache is discarded; an unknown account is accepted", (t) => {
  const home = codexHome(t);
  write(home, globalState({
    "primary-aeon-selection-v1": primary({ accountId: OTHER_ACCOUNT }),
    "orbit-activity-snapshots-v1": snapshots([{ accountId: OTHER_ACCOUNT, statuses: ["in_progress"] }]),
  }));
  const cache = createDotsLocalCache();
  assert.equal(cache.read({ codexHome: home, accountId: ACCOUNT }), null);
  assert.equal(cache.read({ codexHome: home, accountId: null }).dots.length, 1);

  write(home, globalState({
    "primary-aeon-selection-v1": primary(),
    "orbit-activity-snapshots-v1": snapshots([{ accountId: OTHER_ACCOUNT, statuses: ["in_progress"] }]),
  }), STATE_FILE, Date.UTC(2026, 9, 8, 11, 5, 0));
  assert.deepEqual(cache.read({ codexHome: home, accountId: ACCOUNT }).activity, { [TBO_ID]: 0 }, "another account's activity is ignored");
});

test("a cached 'no dot' answer and a missing selection are told apart", (t) => {
  const home = codexHome(t);
  write(home, globalState({ "primary-aeon-selection-v1": primary({ profile: null }) }));
  const none = createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT });
  assert.deepEqual(none.dots, []);
  assert.deepEqual(none.activity, {});

  write(home, globalState({ "primary-aeon-selection-v1": null }), STATE_FILE, Date.UTC(2026, 9, 8, 11, 6, 0));
  assert.equal(createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT }), null);
  write(home, { "electron-persisted-atom-state": "not json" }, STATE_FILE, Date.UTC(2026, 9, 8, 11, 7, 0));
  assert.equal(createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT }), null);
  write(home, [1, 2], STATE_FILE, Date.UTC(2026, 9, 8, 11, 8, 0));
  assert.equal(createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT }), null);
});

test("a missing file or Codex home gives no cache", (t) => {
  const cache = createDotsLocalCache();
  assert.equal(cache.read({ codexHome: codexHome(t), accountId: ACCOUNT }), null);
  assert.equal(cache.read({ codexHome: "", accountId: ACCOUNT }), null);
  assert.equal(cache.read({}), null);
});

test("the file is parsed again only when its mtime or size changes, per Codex home", (t) => {
  const home = codexHome(t);
  const otherHome = codexHome(t);
  write(home, globalState({ "primary-aeon-selection-v1": primary() }));
  write(otherHome, globalState({ "primary-aeon-selection-v1": primary({ profile: dotProfile({ display_name: "Other Dot" }) }) }));
  let reads = 0;
  const countingFs = {
    statSync: (...args) => fs.statSync(...args),
    readFileSync: (...args) => {
      reads += 1;
      return fs.readFileSync(...args);
    },
  };
  const cache = createDotsLocalCache({ fs: countingFs });

  cache.read({ codexHome: home, accountId: ACCOUNT });
  cache.read({ codexHome: home, accountId: ACCOUNT });
  assert.equal(reads, 1);

  write(home, globalState({ "primary-aeon-selection-v1": primary({ profile: dotProfile({ is_paused: true }) }) }), STATE_FILE, Date.UTC(2026, 9, 8, 11, 30, 0));
  assert.equal(cache.read({ codexHome: home, accountId: ACCOUNT }).dots[0].paused, true);
  assert.equal(reads, 2);

  assert.equal(cache.read({ codexHome: otherHome, accountId: ACCOUNT }).dots[0].name, "Other Dot", "a new CODEX_HOME is read at once");
  assert.equal(reads, 3);
});

test("reading the cache writes nothing to the console", (t) => {
  const home = codexHome(t);
  write(home, "broken");
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const printed = [];
  for (const name of Object.keys(original)) console[name] = (...args) => printed.push(args);
  try {
    createDotsLocalCache().read({ codexHome: home, accountId: ACCOUNT });
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(printed, []);
});
