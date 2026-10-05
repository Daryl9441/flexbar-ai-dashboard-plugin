"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");

const { readJsonlTailBytes } = require("../src/collectors/jsonl");
const { attachCodexThreadActivity } = require("../src/collectors/codex");
const {
  applyOverviewTitleMode,
  buildDashboardViewModel,
  buildSessionOverview,
  createDashboardState,
} = require("../src/dashboard/viewModel");
const { renderSessionOverviewKey, sessionOverviewLayout } = require("../src/dashboard/render");

const NOW = Date.parse("2026-05-13T08:30:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (msBeforeNow) => new Date(NOW - msBeforeNow).toISOString();
const running = (msBeforeNow = 5_000) => ({ state: "tool", detail: "shell_command", lastEventAt: iso(msBeforeNow) });
const approval = (msBeforeNow) => ({ state: "approval", detail: "shell_command", lastEventAt: iso(msBeforeNow) });
const done = (msBeforeNow) => ({ state: "idle", detail: "task_complete", lastEventAt: iso(msBeforeNow) });
// What the collectors report for a session they could not read this time.
const unknown = () => ({ state: "unknown", detail: "no session events", lastEventAt: null });
const session = (id, title, msBeforeNow, activity) => ({ id, title, lastActivityAt: iso(msBeforeNow), activity });
const listed = (overview) => overview.items.map((item) => [item.title, item.status, item.statusColor]);

function snapshotWith(sessions) {
  return { providers: { codex: { provider: "codex", sessions, activeSession: null, activity: { state: "idle" } } } };
}

// A dashboard state that records every noteSession call.
function recordingState() {
  const state = createDashboardState();
  const noted = [];
  return {
    ...state,
    noted,
    noteSession(sessionKey, isActive) {
      noted.push([sessionKey, isActive]);
      state.noteSession(sessionKey, isActive);
    },
  };
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("overview lists approvals, then running, then recently finished sessions, each newest first", () => {
  const snapshot = snapshotWith([
    session("old", "Finished yesterday", 24 * HOUR, done(24 * HOUR)),
    session("done-old", "Fixed CI", 20 * MINUTE, done(20 * MINUTE)),
    session("run-old", "Refactor renderer", 10 * MINUTE, running(10 * MINUTE)),
    session("ask", "Install deps", 1 * MINUTE, approval(1 * MINUTE)),
    session("done-new", "Bump version", 5 * MINUTE, done(5 * MINUTE)),
    session("expired", "Finished an hour ago", 31 * MINUTE, done(31 * MINUTE)),
    session("run-new", "Write docs", 2_000, { state: "thinking", lastEventAt: iso(2_000) }),
    session("ask-old", "Run migration", 2 * HOUR, approval(2 * HOUR)),
  ]);

  const overview = buildSessionOverview(snapshot, createDashboardState(), { now: NOW });

  assert.deepEqual(listed(overview), [
    ["Install deps", "approval", "orange"],
    ["Run migration", "approval", "orange"],
    ["Write docs", "running", "blue"],
    ["Refactor renderer", "running", "blue"],
    ["Bump version", "done", "green"],
    ["Fixed CI", "done", "green"],
  ]);
  assert.equal(overview.runningCount, 4);
  assert.equal(overview.doneCount, 2);
});

test("overview drops running sessions with no event for 30 minutes without noting them", () => {
  const state = recordingState();
  const snapshot = snapshotWith([
    session("killed", "Killed mid tool call", 2 * HOUR, running(2 * HOUR)),
    session("thinking", "Stopped while thinking", 31 * MINUTE, { state: "thinking", lastEventAt: iso(31 * MINUTE) }),
    session("slow", "Slow build", 29 * MINUTE, running(29 * MINUTE)),
    { id: "untimed", title: "No timestamps", activity: { state: "tool", detail: "shell_command" } },
  ]);

  const overview = buildSessionOverview(snapshot, state, { now: NOW });

  assert.deepEqual(listed(overview), [
    ["Slow build", "running", "blue"],
    ["No timestamps", "running", "blue"],
  ], "an active session without any timestamp cannot be judged stale");
  assert.deepEqual(state.noted.filter(([, isActive]) => !isActive), []);
  assert.deepEqual(state.noted.map(([sessionKey]) => sessionKey).sort(), ["codex:slow", "codex:untimed"]);

  // The single-session keys still note the stale session as active; the overview
  // leaves that alone, so it never flips to "finished" between the two.
  for (let tick = 0; tick < 3; tick++) {
    const [view] = buildDashboardViewModel(snapshot, state, { now: NOW, sessionSlots: 4 }).sessions
      .filter((item) => item.sessionKey === "codex:killed");
    assert.equal(view.status, "running");
    buildSessionOverview(snapshot, state, { now: NOW });
    assert.equal(state.isUnreadFinished("codex:killed"), false);
  }
});

test("overview keeps an approval request listed for 6 hours, ahead of running sessions", () => {
  const snapshot = snapshotWith([
    session("run", "Refactor renderer", 2_000, running(2_000)),
    session("away", "Push release tag", 3 * HOUR, approval(3 * HOUR)),
    session("forgotten", "Delete build cache", 7 * HOUR, approval(7 * HOUR)),
  ]);

  assert.deepEqual(listed(buildSessionOverview(snapshot, createDashboardState(), { now: NOW })), [
    ["Push release tag", "approval", "orange"],
    ["Refactor renderer", "running", "blue"],
  ]);
});

test("overview skips sessions the collector could not inspect unless they finished unseen", () => {
  const state = recordingState();
  const at = (activity) => snapshotWith([session("s1", "Long task", 1 * MINUTE, activity)]);

  assert.deepEqual(buildSessionOverview(at(unknown()), state, { now: NOW }).items, [], "never seen: skipped");
  assert.deepEqual(state.noted, [], "an unknown session is not noted");

  // Running, then unreadable for a refresh: still running as far as we know, not finished.
  buildSessionOverview(at(running(1 * MINUTE)), state, { now: NOW });
  buildDashboardViewModel(at(unknown()), state, { sessionSlots: 1 });
  assert.deepEqual(buildSessionOverview(at(unknown()), state, { now: NOW }).items, []);
  assert.equal(state.isUnreadFinished("codex:s1"), false);

  // Finished while watched, then unreadable: stays listed as done until viewed.
  buildSessionOverview(at(done(1 * MINUTE)), state, { now: NOW });
  assert.deepEqual(listed(buildSessionOverview(at(unknown()), state, { now: NOW })), [["Long task", "done", "green"]]);
  state.markViewed("codex:s1");
  assert.deepEqual(buildSessionOverview(at(unknown()), state, { now: NOW }).items, []);
});

test("overview lists a stale session that finished unseen as done, by recency", () => {
  const state = createDashboardState();
  const anHourAgo = NOW - HOUR;
  // Seen running, then finished an hour ago without being viewed...
  buildSessionOverview(snapshotWith([session("s-old", "Old task", HOUR + MINUTE, running(HOUR + MINUTE))]), state, { now: anHourAgo });
  buildSessionOverview(snapshotWith([session("s-old", "Old task", HOUR, done(HOUR))]), state, { now: anHourAgo });
  // ...and now reported running again, with no event since.
  const overview = buildSessionOverview(snapshotWith([
    session("s-old", "Old task", HOUR, running(HOUR)),
    session("s-new", "New task", 5 * MINUTE, done(5 * MINUTE)),
  ]), state, { now: NOW });

  assert.deepEqual(listed(overview), [["New task", "done", "green"], ["Old task", "done", "green"]]);
});

test("overview keeps a session that finished while watched until it is viewed", () => {
  const state = createDashboardState();
  const runningSnapshot = snapshotWith([session("s1", "Long task", 3 * HOUR, running(3 * HOUR))]);
  const finishedSnapshot = snapshotWith([session("s1", "Long task", 3 * HOUR - MINUTE, done(3 * HOUR - MINUTE))]);

  // Seen running three hours ago, finished a minute later, not looked at since.
  buildSessionOverview(runningSnapshot, state, { now: NOW - 3 * HOUR + 5_000 });
  const finished = buildSessionOverview(finishedSnapshot, state, { now: NOW });
  assert.deepEqual(finished.items.map((item) => item.status), ["done"], "seen running, now finished: listed although old");

  state.markViewed(finished.items[0].sessionKey);
  assert.deepEqual(buildSessionOverview(finishedSnapshot, state, { now: NOW }).items, []);
});

test("overview applies the key's latest-title mode", () => {
  const snapshot = snapshotWith([
    { id: "run", title: "First prompt", latestTitle: "Latest prompt", lastActivityAt: iso(1_000), activity: running(1_000) },
  ]);
  const overview = buildSessionOverview(snapshot, createDashboardState(), { now: NOW });

  assert.equal(overview.items[0].title, "First prompt");
  assert.equal(applyOverviewTitleMode(overview, "latest").items[0].title, "Latest prompt");
  assert.equal(applyOverviewTitleMode(overview, "initial"), overview);
});

const item = (title, status = "running") => ({ title, status, statusColor: { approval: "orange", running: "blue", done: "green" }[status] });
const FONT_PX = (draw) => Number(/(\d+)px/.exec(draw.font)[1]);

test("overview renderer draws a colored dot and title per session in a 3-row grid", () => {
  const fake = createFakeCanvasModule();
  const items = [item("Install deps", "approval"), item("Refactor renderer"), item("Fixed CI", "done"), item("Docs", "done")];

  const image = renderSessionOverviewKey({ items }, { width: 520, canvasModule: fake });

  assert.equal(image, "data:image/png;base64,fake");
  assert.deepEqual(fake.sizes, [{ width: 520, height: 60 }]);
  assert.deepEqual(fake.texts, ["Install deps", "Refactor renderer", "Fixed CI", "Docs"]);
  assert.deepEqual(fake.arcs.map((arc) => [arc.fill, arc.x, arc.y]), [
    ["#f97316", 13, 12], ["#38bdf8", 13, 30], ["#22c55e", 13, 48], ["#22c55e", 265, 12],
  ], "4 sessions on 520px: 2 columns of 252px, 3 rows");
  assert.deepEqual(fake.textDraws.map((draw) => [draw.x, draw.y, draw.color]), [
    [23, 16.5, "#ffffff"], [23, 34.5, "#ffffff"], [23, 52.5, "#d4d4d8"], [275, 16.5, "#d4d4d8"],
  ]);
  assert.match(fake.textDraws[0].font, /^bold 13px /, "running titles are bold");
  assert.match(fake.textDraws[2].font, /^13px /, "finished titles are regular");
});

test("overview columns are as wide as the session count allows, with titles cut to fit", () => {
  const long = "Migrate the settings page to new forms"; // 38 chars: 304px in the fake 8px-per-char font
  const render = (width, count) => {
    const fake = createFakeCanvasModule();
    const items = Array.from({ length: count }, (_, index) => item(index === 0 ? long : `Task ${index}`));
    renderSessionOverviewKey({ items }, { width, canvasModule: fake });
    return fake;
  };
  const columnsOf = (fake) => [...new Set(fake.textDraws.map((draw) => draw.x))];

  // 240px: two 112px columns, 12px text, titles cut to 91px (8 chars + "...").
  const narrow = render(240, 4);
  assert.deepEqual(columnsOf(narrow), [23, 135]);
  assert.deepEqual(narrow.texts, ["Migrate ...", "Task 1", "Task 2", "Task 3"]);
  assert.deepEqual(narrow.textDraws.map(FONT_PX), [12, 12, 12, 12]);

  // 520px holds 4 columns, but 4 sessions only need 2: each is 252px wide.
  const wide = render(520, 4);
  assert.deepEqual(columnsOf(wide), [23, 275]);
  assert.equal(wide.texts[0], "Migrate the settings page...");
  assert.deepEqual(wide.textDraws.map(FONT_PX), [13, 13, 13, 13]);

  // 520px, 9 sessions: 3 columns of 168px.
  assert.deepEqual(columnsOf(render(520, 9)), [23, 191, 359]);

  // 760px: 2 columns of 372px for 4 sessions; the whole title fits.
  const wider = render(760, 4);
  assert.deepEqual(columnsOf(wider), [23, 395]);
  assert.equal(wider.texts[0], long);

  // 760px, 20 sessions: all 6 columns (124px, so 12px text), 17 titles and "+3".
  const full = render(760, 20);
  assert.equal(columnsOf(full).length, 6);
  assert.equal(full.texts.length, 18);
  assert.deepEqual(full.textDraws.at(-1), { text: "+3", x: 643, y: 52, font: full.textDraws.at(-1).font, color: "#38bdf8" });
  assert.equal(FONT_PX(full.textDraws.at(-1)), 12);

  // A single session gets the whole key, centered vertically.
  const single = render(520, 1);
  assert.deepEqual(single.texts, [long]);
  assert.deepEqual([single.arcs[0].y, single.textDraws[0].y], [30, 34.5]);

  assert.deepEqual(sessionOverviewLayout(240, 6), sessionOverviewLayout("240", 6));
  assert.equal(sessionOverviewLayout(100, 5).visibleCount, 2, "under 236px a key has one column: 2 titles + \"+N\"");
});

test("overview +N counts the hidden sessions and turns blue when it hides one still running", () => {
  const render = (items) => {
    const fake = createFakeCanvasModule();
    renderSessionOverviewKey({ items }, { width: 240, canvasModule: fake });
    return fake;
  };

  // 240px fits 6 slots: 5 titles + "+N".
  const onlyDoneHidden = render([
    item("Ask", "approval"), item("Run 1"), item("Run 2"), item("Done 1", "done"), item("Done 2", "done"),
    item("Done 3", "done"), item("Done 4", "done"),
  ]);
  assert.deepEqual(onlyDoneHidden.texts, ["Ask", "Run 1", "Run 2", "Done 1", "Done 2", "+2"]);
  assert.equal(onlyDoneHidden.textDraws.at(-1).color, "#a1a1aa");

  const runningHidden = render([
    item("Ask", "approval"), item("Run 1"), item("Run 2"), item("Run 3"), item("Run 4"), item("Run 5"),
    item("Done 1", "done"),
  ]);
  assert.deepEqual(runningHidden.texts, ["Ask", "Run 1", "Run 2", "Run 3", "Run 4", "+2"]);
  assert.equal(runningHidden.textDraws.at(-1).color, "#38bdf8");

  const exact = render(Array.from({ length: 6 }, (_, index) => item(`Run ${index}`)));
  assert.equal(exact.texts.length, 6, "6 sessions fill 240px exactly: no +N");
  assert.ok(!exact.texts.some((text) => text.startsWith("+")));
});

test("overview renderer shows a hint when no session is listed", () => {
  const empty = createFakeCanvasModule();
  renderSessionOverviewKey({ items: [] }, { width: 520, language: "zh-CN", canvasModule: empty });
  assert.deepEqual(empty.texts, ["没有活跃会话"]);
});

test("bounded JSONL tail drops the line cut by the byte window", (t) => {
  const file = path.join(tempDir(t, "flexbar-jsonl-"), "rollout.jsonl");
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(100) }));
  fs.writeFileSync(file, lines.join("\n") + "\n");

  assert.deepEqual(readJsonlTailBytes(file, { maxBytes: 1_000, maxLines: 5 }).map((entry) => entry.i), [45, 46, 47, 48, 49]);
  // Each line is 118 bytes with its newline: the last 300 bytes hold lines 48 and 49
  // whole and the end of line 47, which is dropped rather than parsed.
  assert.equal(Buffer.byteLength(`${lines[47]}\n`), 118);
  assert.deepEqual(readJsonlTailBytes(file, { maxBytes: 300 }).map((entry) => entry.i), [48, 49]);
  assert.deepEqual(readJsonlTailBytes(path.join(path.dirname(file), "missing.jsonl")), []);
});

test("Codex app-server threads get per-thread activity from their recent rollout files", (t) => {
  const dir = tempDir(t, "flexbar-codex-threads-");
  const now = Date.now();
  const at = (msBeforeNow) => new Date(now - msBeforeNow).toISOString();
  const write = (name, events, mtimeMsBeforeNow = 0) => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const mtime = new Date(now - mtimeMsBeforeNow);
    fs.utimesSync(file, mtime, mtime);
    return file;
  };
  const runningFile = write("running", [
    { timestamp: at(4_000), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(2_000), type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: "{\"command\":\"npm test\"}", call_id: "c1" } },
  ]);
  const doneFile = write("done", [
    { timestamp: at(60_000), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(50_000), type: "event_msg", payload: { type: "task_complete" } },
  ], 50_000);
  const oldFile = write("old", [
    { timestamp: at(7 * 3600_000), type: "event_msg", payload: { type: "task_started" } },
  ], 7 * 3600_000);

  const cache = new Map();
  const threads = [
    { id: "r", title: "Running", path: runningFile },
    { id: "d", title: "Done", path: doneFile },
    { id: "o", title: "Old", path: oldFile },
    { id: "n", title: "No file" },
  ];
  const result = attachCodexThreadActivity(threads, { now, cache });

  assert.equal(result[0].activity.state, "tool");
  assert.equal(result[0].lastActivityAt, at(2_000));
  assert.equal(result[1].activity.detail, "task_complete");
  assert.equal(result[2], threads[2], "files untouched for longer than the window are not read");
  assert.equal(result[3], threads[3]);
  assert.deepEqual([...cache.keys()].sort(), [doneFile, runningFile].sort());

  // Unchanged files come from the cache; a cache entry for a file that is gone is dropped.
  const cachedEvents = cache.get(doneFile).events;
  cache.set("/no/longer/listed.jsonl", { mtimeMs: 0, size: 0, events: [] });
  const again = attachCodexThreadActivity(threads, { now, cache });
  assert.equal(cache.get(doneFile).events, cachedEvents);
  assert.equal(cache.has("/no/longer/listed.jsonl"), false);
  assert.equal(again[1].activity.detail, "task_complete");

  assert.equal(attachCodexThreadActivity(threads, { now, cache: new Map(), maxThreads: 1 })[1].activity.state, "unknown");
});

// Runs plugin.js against a fake FlexDesigner SDK and snapshot collector, taps the
// first AI Session key (else the first key) on the scenario's schedule and prints every
// image drawn, what each tap drew before returning, and the options of every snapshot
// collection. OVERVIEW_SCENARIO: { width, keys?: [{ cid, data }], alive?: [{ at, keys }],
// phases: [{ at, sessions, quota?, automations? }], taps: [ms], messages?: [{ at,
// payload }], intervalMs?, endAt }, with sessions as { id, title, agoMs, state: "tool" |
// "done" } relative to the phase, automations as { id, name, status?, inMs? } (next run
// inMs from now) and cid the key's suffix ("session", "plan-usage", ...). alive reloads
// the page with another key list; intervalMs caps the timers (default 50ms).
const FAKE_SDK_HOST = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const root = process.env.PLUGIN_ROOT;
const scenario = JSON.parse(process.env.OVERVIEW_SCENARIO);
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-ai-dashboard-overview-"));
const handlers = {};
const draws = [];
const snapshotCalls = [];
const startedAt = Date.now();

// Refresh snapshots every 50ms instead of every 2s so phases switch quickly.
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms, ...args) => realSetInterval(fn, Math.min(ms, scenario.intervalMs || 50), ...args);

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
    draw(serialNumber, key, type, image) {
      draws.push({ uid: key.uid, type, image, title: key.title });
      return Promise.resolve({});
    },
    getConfig: () => Promise.resolve({}),
    setConfig: () => Promise.resolve({}),
  },
});
function codexSession({ id, title, agoMs, state }) {
  const at = new Date(Date.now() - agoMs).toISOString();
  const activity = state === "done" ? { state: "idle", detail: "task_complete", lastEventAt: at } : { state, lastEventAt: at };
  return { id, title, lastActivityAt: at, activity };
}
function automationItem({ id, name, status = "active", inMs }) {
  return { id, name, status, rawStatus: status.toUpperCase(), nextRunAt: inMs === undefined ? null : Date.now() + inMs, updatedAt: Date.now() };
}
fake(path.join(root, "src", "collectors", "snapshot.js"), {
  collectAiSnapshot: async (options = {}) => {
    snapshotCalls.push({ automations: options.automations });
    const phase = scenario.phases.filter((item) => item.at <= Date.now() - startedAt).at(-1);
    const sessions = phase.sessions.map(codexSession);
    const automations = phase.automations && options.automations !== false
      ? { available: true, reason: null, stale: false, total: phase.automations.length, items: phase.automations.map(automationItem) }
      : undefined;
    return {
      collectedAt: new Date().toISOString(),
      providers: {
        codex: { provider: "codex", sessions, activeSession: sessions[0] || null, activity: { state: "idle" }, usage: null, quota: phase.quota || null },
      },
      automations,
    };
  },
  compactSnapshot: (snapshot) => snapshot,
});
// Record which renderer drew each image and with what view.
const render = require(path.join(root, "src", "dashboard", "render.js"));
fake(path.join(root, "src", "dashboard", "render.js"), {
  ...render,
  renderSessionKey: (view) => "session:" + JSON.stringify({ title: view.title }),
  renderSessionOverviewKey: (view) => "overview:" + JSON.stringify(view.items.map((item) => [item.title, item.statusColor])),
  renderAutomationOverviewKey: (view) => "automations:" + JSON.stringify(view.items.map((item) => [item.title, item.statusColor, item.timeLabel])),
  renderPlanUsageKey: (view) => "plan:" + JSON.stringify(view.items.map((item) => [item.label, item.remainingPercent])),
});

require(path.join(root, "src", "plugin.js"));
const makeKeys = (list) => list.map((item, index) => ({
  uid: index + 1,
  cid: "com.aspen.flexbar-ai-dashboard." + item.cid,
  width: scenario.width,
  title: "x",
  style: {},
  data: item.data,
}));
let keys = makeKeys(scenario.keys || [{ cid: "session", data: { sessionTitleMode: "initial" } }]);
const tapDraws = [];
const tap = () => {
  const key = keys.find((item) => item.cid.endsWith(".session")) || keys[0];
  const before = draws.length;
  handlers["plugin.data"]({ serialNumber: "001100AA0001", data: { evt: "click", key } });
  // What the tap itself drew, synchronously, before any refresh tick could.
  tapDraws.push(draws.slice(before).filter((d) => d.uid === key.uid).map((d) => (d.type === "base64" ? d.image : "draw:" + d.title)));
};
handlers["plugin.alive"]({ serialNumber: "001100AA0001", keys });
for (const { at, keys: list } of scenario.alive || []) {
  setTimeout(() => {
    keys = makeKeys(list);
    handlers["plugin.alive"]({ serialNumber: "001100AA0001", keys });
  }, at);
}
for (const at of scenario.taps) setTimeout(tap, at);
for (const { at, payload } of scenario.messages || []) setTimeout(() => handlers["ui.message"](payload), at);
setTimeout(() => {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  const images = draws.filter((d) => d.type === "base64");
  process.stdout.write(JSON.stringify({ images: images.map((d) => d.image), keyImages: images.map((d) => [d.uid, d.image]), tapDraws, snapshotCalls }));
  process.exit(0);
}, scenario.endAt);
`;

function runOverviewHostOutput(scenario) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", FAKE_SDK_HOST], {
      encoding: "utf8",
      env: { ...process.env, PLUGIN_ROOT: path.join(__dirname, ".."), OVERVIEW_SCENARIO: JSON.stringify(scenario) },
      timeout: 30_000,
    }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout))));
  });
}

const withoutRepeats = (images) => images.filter((image, index) => image !== images[index - 1]);

async function runOverviewHost(scenario) {
  const { images } = await runOverviewHostOutput(scenario);
  return withoutRepeats(images);
}

test("tapping an AI Session key cycles its session, the all-sessions overview and the scheduled tasks", async () => {
  const { images, tapDraws, snapshotCalls } = await runOverviewHostOutput({
    width: 520,
    phases: [{
      at: 0,
      sessions: [
        { id: "a", title: "Running task", agoMs: 1_000, state: "tool" },
        { id: "b", title: "Finished task", agoMs: 60_000, state: "done" },
      ],
      automations: [
        { id: "t1", name: "Made-up weekly report", status: "paused" },
        { id: "t2", name: "Made-up inbox sweep", inMs: 25 * 60_000 },
      ],
    }],
    taps: [400, 800, 1_200, 1_600],
    endAt: 2_000,
  });

  const views = [
    "session:{\"title\":\"Running task\"}",
    "overview:[[\"Running task\",\"blue\"],[\"Finished task\",\"green\"]]",
    "automations:[[\"Made-up inbox sweep\",\"green\",\"in 25m\"],[\"Made-up weekly report\",\"gray\",\"Paused\"]]",
  ];
  assert.deepEqual(withoutRepeats(images), [views[0], views[1], views[2], views[0], views[1]]);
  // Each tap redraws the key itself, without waiting for the next refresh tick.
  assert.deepEqual(tapDraws, [[views[1]], [views[2]], [views[0]], [views[1]]]);
  assert.ok(snapshotCalls.length > 0);
  assert.ok(snapshotCalls.every((call) => call.automations === true), "an AI Session key needs the scheduled tasks");
});

test("a key showing the scheduled tasks takes no session slot", async () => {
  const { keyImages } = await runOverviewHostOutput({
    width: 520,
    keys: [
      { cid: "session", data: { sessionTitleMode: "initial" } },
      { cid: "session", data: { sessionTitleMode: "initial" } },
    ],
    phases: [{
      at: 0,
      sessions: [
        { id: "a", title: "Newest task", agoMs: 1_000, state: "tool" },
        { id: "b", title: "Older task", agoMs: 5_000, state: "tool" },
      ],
      automations: [],
    }],
    taps: [400, 800],
    endAt: 1_200,
  });

  const imagesOf = (uid) => withoutRepeats(keyImages.filter(([key]) => key === uid).map(([, image]) => image));
  assert.deepEqual(imagesOf(1), [
    "session:{\"title\":\"Newest task\"}",
    "overview:[[\"Newest task\",\"blue\"],[\"Older task\",\"blue\"]]",
    "automations:[]",
  ]);
  assert.deepEqual(imagesOf(2), [
    "session:{\"title\":\"Older task\"}",
    "session:{\"title\":\"Newest task\"}",
  ], "the other key takes over the first session while key 1 shows a list");
});

test("scheduled tasks not collected yet show the loading look and are fetched at once", async () => {
  // Only a Plan Usage key at first, so the snapshots skip the scheduled tasks; then an AI
  // Session key is added and tapped twice before the next (real, 2s) refresh tick.
  const plan = { cid: "plan-usage", data: {} };
  const { keyImages, tapDraws, snapshotCalls } = await runOverviewHostOutput({
    width: 520,
    keys: [plan],
    alive: [{ at: 300, keys: [plan, { cid: "session", data: { sessionTitleMode: "initial" } }] }],
    phases: [{
      at: 0,
      sessions: [{ id: "a", title: "Running task", agoMs: 1_000, state: "tool" }],
      automations: [{ id: "t1", name: "Made-up inbox sweep", inMs: 25 * 60_000 }],
    }],
    taps: [400, 500],
    intervalMs: 60_000,
    endAt: 900,
  });

  const sessionKeyImages = withoutRepeats(keyImages.filter(([uid]) => uid === 2).map(([, image]) => image));
  assert.deepEqual(sessionKeyImages, [
    "session:{\"title\":\"Running task\"}",
    "overview:[[\"Running task\",\"blue\"]]",
    "automations:[[\"Made-up inbox sweep\",\"green\",\"in 25m\"]]",
  ], "never \"Scheduled tasks unavailable\" (automations:[]) while they were simply not read yet");
  assert.deepEqual(tapDraws[1], ["draw:AI loading..."]);
  assert.deepEqual(snapshotCalls, [{ automations: false }, { automations: true }], "the tap fetched them without waiting for the tick");
});

test("only AI Session keys collect scheduled tasks; the recent-projects list never does", async () => {
  const planOnly = await runOverviewHostOutput({
    width: 280,
    keys: [{ cid: "plan-usage", data: {} }],
    phases: [{ at: 0, sessions: [] }],
    taps: [],
    endAt: 400,
  });
  assert.ok(planOnly.snapshotCalls.length > 0);
  assert.ok(planOnly.snapshotCalls.every((call) => call.automations === false));

  // A lone New Codex Session key runs no snapshot loop; its project list collects once.
  const recentProjects = await runOverviewHostOutput({
    width: 240,
    keys: [{ cid: "new-session", data: { mode: "codex", projectPath: "", prompt: "" } }],
    phases: [{ at: 0, sessions: [] }],
    taps: [],
    messages: [{ at: 100, payload: { type: "recentProjects" } }],
    endAt: 600,
  });
  assert.deepEqual(recentProjects.snapshotCalls, [{ automations: false }]);
});

test("leaving the overview marks only the finished sessions it showed as viewed", async () => {
  // 8 sessions run, then all finish (long ago, so only "finished unseen" lists them).
  const sessions = (state, agoMs) => Array.from({ length: 8 }, (_, index) => ({
    id: `s${index + 1}`,
    title: `Task ${index + 1}`,
    agoMs: agoMs + index * 60_000,
    state,
  }));
  const distinct = await runOverviewHost({
    width: 240,
    phases: [
      { at: 0, sessions: sessions("tool", 1_000), automations: [] },
      { at: 300, sessions: sessions("done", 2 * 3600_000), automations: [] },
    ],
    taps: [600, 900, 1_200, 1_500],
    endAt: 1_800,
  });

  const done = (...numbers) => `overview:${JSON.stringify(numbers.map((number) => [`Task ${number}`, "green"]))}`;
  assert.deepEqual(distinct, [
    "session:{\"title\":\"Task 1\"}",
    // Tap 1: the key's own session (Task 1) counts as viewed; 240px shows 5 + "+2".
    done(2, 3, 4, 5, 6, 7, 8),
    // Tap 2 leaves the overview for the scheduled tasks: the 5 it showed are viewed.
    "automations:[]",
    // Tap 3: back home.
    "session:{\"title\":\"Task 1\"}",
    // Tap 4: the 2 that were behind "+2" are still unread.
    done(7, 8),
  ]);
});

test("keys saved with the removed Claude data source show Codex data", async () => {
  // Older versions let each key choose between Codex and Claude Code (data.dataSource).
  const distinct = await runOverviewHost({
    width: 520,
    keys: [
      { cid: "session", data: { dataSource: "claude", sessionTitleMode: "initial" } },
      { cid: "plan-usage", data: { dataSource: "claude" } },
    ],
    phases: [{
      at: 0,
      sessions: [{ id: "a", title: "Codex task", agoMs: 1_000, state: "tool" }],
      quota: { limits: [{ label: "primary", usedPercent: 25, resetAt: 1778696068, windowSeconds: 18000 }] },
    }],
    taps: [400],
    endAt: 800,
  });

  assert.deepEqual([...new Set(distinct)], [
    "session:{\"title\":\"Codex task\"}",
    "plan:[[\"5h\",75]]",
    "overview:[[\"Codex task\",\"blue\"]]",
  ]);
});

function createFakeCanvasModule() {
  const module = { sizes: [], texts: [], textDraws: [], arcs: [] };
  let pendingArc = null;
  const context = {
    fillStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    beginPath() {
      pendingArc = null;
    },
    arc(x, y, radius) {
      pendingArc = { x, y, radius };
    },
    fill() {
      if (pendingArc) module.arcs.push({ ...pendingArc, fill: this.fillStyle });
    },
    fillRect() {},
    measureText(text) {
      return { width: String(text).length * 8 };
    },
    fillText(text, x, y) {
      module.texts.push(text);
      module.textDraws.push({ text, x, y, font: this.font, color: this.fillStyle });
    },
  };
  module.createCanvas = (width, height) => {
    module.sizes.push({ width, height });
    return {
      getContext: () => context,
      toDataURL: () => "data:image/png;base64,fake",
    };
  };
  return module;
}
