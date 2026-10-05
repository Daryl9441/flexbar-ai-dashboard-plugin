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
  buildSessionOverview,
  createDashboardState,
} = require("../src/dashboard/viewModel");
const { renderSessionOverviewKey } = require("../src/dashboard/render");

const NOW = Date.parse("2026-05-13T08:30:00.000Z");
const iso = (msBeforeNow) => new Date(NOW - msBeforeNow).toISOString();
const running = (msBeforeNow = 5_000) => ({ state: "tool", detail: "shell_command", lastEventAt: iso(msBeforeNow) });
const done = (msBeforeNow) => ({ state: "idle", detail: "task_complete", lastEventAt: iso(msBeforeNow) });

function snapshotWith(codexSessions, claudeSessions = []) {
  const provider = (name, sessions) => ({ provider: name, sessions, activeSession: null, activity: { state: "idle" } });
  return { providers: { codex: provider("codex", codexSessions), claude: provider("claude", claudeSessions) } };
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("overview lists running, approval and recently finished sessions, running first", () => {
  const snapshot = snapshotWith([
    { id: "old", title: "Finished yesterday", updatedAt: iso(24 * 3600_000), activity: done(24 * 3600_000) },
    { id: "done", title: "Fixed CI", lastActivityAt: iso(10 * 60_000), activity: done(10 * 60_000) },
    { id: "run", title: "Refactor renderer", lastActivityAt: iso(2_000), activity: running(2_000) },
    { id: "ask", title: "Install deps", lastActivityAt: iso(60_000), activity: { state: "approval", lastEventAt: iso(60_000) } },
  ]);

  const overview = buildSessionOverview(snapshot, createDashboardState(), { now: NOW });

  assert.deepEqual(overview.items.map((item) => [item.title, item.status, item.statusColor]), [
    ["Refactor renderer", "running", "blue"],
    ["Install deps", "approval", "orange"],
    ["Fixed CI", "done", "green"],
  ]);
  assert.equal(overview.runningCount, 2);
  assert.equal(overview.doneCount, 1);
});

test("overview keeps a session that finished while watched until it is viewed", () => {
  const state = createDashboardState();
  const longAgo = 3 * 3600_000;
  const session = (activity) => snapshotWith([{ id: "s1", title: "Long task", lastActivityAt: iso(longAgo), activity }]);

  buildSessionOverview(session(running(longAgo)), state, { now: NOW });
  const finished = buildSessionOverview(session(done(longAgo)), state, { now: NOW });
  assert.deepEqual(finished.items.map((item) => item.status), ["done"], "seen running, now finished: listed although old");

  state.markViewed(finished.items[0].sessionKey);
  assert.deepEqual(buildSessionOverview(session(done(longAgo)), state, { now: NOW }).items, []);
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

test("overview renderer draws a colored dot and title per session in a 3-row grid", () => {
  const fake = createFakeCanvasModule();
  const items = [
    { title: "Refactor renderer", status: "running", statusColor: "blue" },
    { title: "Install deps", status: "approval", statusColor: "orange" },
    { title: "Fixed CI", status: "done", statusColor: "green" },
    { title: "Docs", status: "done", statusColor: "green" },
  ];

  const image = renderSessionOverviewKey({ items }, { width: 520, canvasModule: fake });

  assert.equal(image, "data:image/png;base64,fake");
  assert.deepEqual(fake.sizes, [{ width: 520, height: 60 }]);
  assert.deepEqual(fake.texts, ["Refactor renderer", "Install deps", "Fixed CI", "Docs"]);
  assert.deepEqual(fake.arcFills, ["#38bdf8", "#f97316", "#22c55e", "#22c55e"]);
  const [first, , , fourth] = fake.textDraws;
  assert.ok(fourth.x > first.x, "the 4th session starts a second column");
  assert.equal(fourth.y, first.y);
});

test("overview renderer shows +N when sessions do not fit and a hint when there are none", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ title: `Task ${index}`, status: "running", statusColor: "blue" }));

  const narrow = createFakeCanvasModule();
  renderSessionOverviewKey({ items }, { width: 240, canvasModule: narrow });
  assert.deepEqual(narrow.texts, ["Task 0", "Task 1", "+8"]);

  const empty = createFakeCanvasModule();
  renderSessionOverviewKey({ items: [] }, { width: 520, language: "zh-CN", canvasModule: empty });
  assert.deepEqual(empty.texts, ["没有活跃会话"]);
});

test("bounded JSONL tail drops the line cut by the byte window", (t) => {
  const file = path.join(tempDir(t, "flexbar-jsonl-"), "rollout.jsonl");
  fs.writeFileSync(file, Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(100) })).join("\n") + "\n");

  assert.deepEqual(readJsonlTailBytes(file, { maxBytes: 1_000, maxLines: 5 }).map((entry) => entry.i), [45, 46, 47, 48, 49]);
  assert.ok(readJsonlTailBytes(file, { maxBytes: 300 }).every((entry) => typeof entry.i === "number"));
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
    { timestamp: at(5 * 3600_000), type: "event_msg", payload: { type: "task_started" } },
  ], 5 * 3600_000);

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

  assert.equal(attachCodexThreadActivity(threads, { now, cache: new Map(), maxThreads: 1 })[1], threads[1]);
});

const FAKE_SDK_HOST = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const root = process.env.PLUGIN_ROOT;
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-ai-dashboard-overview-"));
const handlers = {};
const draws = [];

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
      draws.push({ uid: key.uid, type, image });
      return Promise.resolve({});
    },
    getConfig: () => Promise.resolve({}),
    setConfig: () => Promise.resolve({}),
  },
});
const now = Date.now();
const at = (ms) => new Date(now - ms).toISOString();
const provider = (name, sessions) => ({ provider: name, sessions, activeSession: sessions[0] || null, activity: { state: "idle" }, usage: null, quota: null });
fake(path.join(root, "src", "collectors", "snapshot.js"), {
  collectAiSnapshot: async () => ({
    collectedAt: new Date().toISOString(),
    providers: {
      codex: provider("codex", [
        { id: "a", title: "Running task", lastActivityAt: at(1000), activity: { state: "tool", lastEventAt: at(1000) } },
        { id: "b", title: "Finished task", lastActivityAt: at(60000), activity: { state: "idle", detail: "task_complete" } },
      ]),
      claude: provider("claude", []),
    },
  }),
  compactSnapshot: (snapshot) => snapshot,
});
// Record which renderer drew each image and with what view.
const render = require(path.join(root, "src", "dashboard", "render.js"));
fake(path.join(root, "src", "dashboard", "render.js"), {
  ...render,
  renderSessionKey: (view) => "session:" + JSON.stringify({ title: view.title }),
  renderSessionOverviewKey: (view) => "overview:" + JSON.stringify(view.items.map((item) => [item.title, item.statusColor])),
});

require(path.join(root, "src", "plugin.js"));
const key = { uid: 1, cid: "com.aspen.flexbar-ai-dashboard.session", width: 520, title: "x", style: {}, data: { dataSource: "codex" } };
const tap = () => handlers["plugin.data"]({ serialNumber: "001100AA0001", data: { evt: "click", key } });
handlers["plugin.alive"]({ serialNumber: "001100AA0001", keys: [key] });
setTimeout(tap, 400);
setTimeout(tap, 800);
setTimeout(() => {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ images: draws.filter((d) => d.type === "base64").map((d) => d.image) }));
  process.exit(0);
}, 1200);
`;

test("tapping an AI Session key toggles between its session and the all-sessions overview", async () => {
  const { images } = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", FAKE_SDK_HOST], {
      encoding: "utf8",
      env: { ...process.env, PLUGIN_ROOT: path.join(__dirname, "..") },
      timeout: 30_000,
    }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout))));
  });

  const distinct = images.filter((image, index) => image !== images[index - 1]);
  assert.deepEqual(distinct, [
    "session:{\"title\":\"Running task\"}",
    "overview:[[\"Running task\",\"blue\"],[\"Finished task\",\"green\"]]",
    "session:{\"title\":\"Running task\"}",
  ]);
});

function createFakeCanvasModule() {
  const module = { sizes: [], texts: [], textDraws: [], arcFills: [] };
  const context = {
    fillStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    _arc: false,
    beginPath() {
      this._arc = false;
    },
    arc() {
      this._arc = true;
    },
    fill() {
      if (this._arc) module.arcFills.push(this.fillStyle);
    },
    fillRect() {},
    measureText(text) {
      return { width: String(text).length * 8 };
    },
    fillText(text, x, y) {
      module.texts.push(text);
      module.textDraws.push({ text, x, y });
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
