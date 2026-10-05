"use strict";

// The Codex collector's per-thread activity read through the session overview's
// listing policy: the two are built separately (the collector reports what each
// rollout says, the view decides what is still live), so these tests check that
// they agree.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { attachCodexThreadActivity } = require("../src/collectors/codex");
const { buildDashboardViewModel, buildSessionOverview, createDashboardState } = require("../src/dashboard/viewModel");

const KB = 1024;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rolloutWriter(dir, now) {
  const at = (msBeforeNow) => new Date(now - msBeforeNow).toISOString();
  const write = (name, entries, mtimeMsBeforeNow) => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const mtime = new Date(now - mtimeMsBeforeNow);
    fs.utimesSync(file, mtime, mtime);
    return file;
  };
  const event = (msBeforeNow, type) => ({ timestamp: at(msBeforeNow), type: "event_msg", payload: { type } });
  const call = (msBeforeNow, callId, args = { command: "npm test" }) => ({
    timestamp: at(msBeforeNow),
    type: "response_item",
    payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify(args), call_id: callId },
  });
  const output = (msBeforeNow, callId, bytes) => ({
    timestamp: at(msBeforeNow),
    type: "response_item",
    payload: { type: "function_call_output", call_id: callId, output: "y".repeat(bytes) },
  });
  return { write, event, call, output };
}

function codexSnapshot(sessions) {
  return { providers: { codex: { provider: "codex", sessions, activeSession: null, activity: { state: "idle" } } } };
}

const statuses = (overview) => overview.items.map((item) => [item.title, item.status]);

test("Codex rollouts read by the collector are listed by the overview policy", (t) => {
  const now = Date.now();
  const { write, event, call, output } = rolloutWriter(tempDir(t, "flexbar-overview-codex-"), now);

  // A turn of about 768 KB, longer than the first 512 KB tail window, still running:
  // its last tool call returned 45 s ago and the model has not written since.
  const longTurn = [event(20 * MINUTE, "task_started")];
  for (let index = 0; index < 12; index += 1) {
    longTurn.push(call(19 * MINUTE - index * 1_000, `k${index}`, { command: "ls" }));
    longTurn.push(output(index === 11 ? 45_000 : 19 * MINUTE - index * 1_000 - 500, `k${index}`, 64 * KB));
  }
  const threads = [
    { id: "long", title: "Long turn", path: write("long", longTurn, 45_000) },
    // Waiting for approval since 3 hours ago while the user is away.
    {
      id: "away",
      title: "Approval while away",
      path: write("away", [
        event(3 * HOUR + MINUTE, "task_started"),
        call(3 * HOUR, "a1", { command: "rm -rf build", sandbox_permissions: "require_escalated" }),
      ], 3 * HOUR),
    },
    // Killed mid tool call 2 hours ago: the open call ages out in the collector, so the
    // single-session key and the overview agree that it is not running.
    { id: "abandoned", title: "Abandoned", path: write("abandoned", [event(2 * HOUR + MINUTE, "task_started"), call(2 * HOUR, "b1")], 2 * HOUR) },
    { id: "done", title: "Finished", path: write("done", [event(6 * MINUTE, "task_started"), event(5 * MINUTE, "task_complete")], 5 * MINUTE) },
  ];

  const sessions = attachCodexThreadActivity(threads, { now, cache: new Map() });
  const byId = Object.fromEntries(sessions.map((session) => [session.id, session]));
  assert.notEqual(byId.long.activity.state, "idle", "the turn's task_started is beyond the first window");
  assert.equal(byId.away.activity.state, "approval");
  assert.equal(byId.abandoned.activity.state, "idle", "an open call older than 30 min is not running");

  const state = createDashboardState();
  assert.deepEqual(statuses(buildSessionOverview(codexSnapshot(sessions), state, { now })), [
    ["Approval while away", "approval"],
    ["Long turn", "running"],
    ["Finished", "done"],
  ]);
  assert.equal(state.isUnreadFinished("codex:abandoned"), false);
});

test("a running Codex thread pushed past the inspection cap is neither listed as done nor marked finished", (t) => {
  const now = Date.now();
  const { write, event, call } = rolloutWriter(tempDir(t, "flexbar-overview-codex-cap-"), now);
  const runningFile = write("running", [event(4 * MINUTE, "task_started"), call(3 * MINUTE, "r1", { command: "make" })], 3 * MINUTE);
  const threads = [{ id: "running", title: "Building", path: runningFile }];
  const state = createDashboardState();

  // First refresh: the thread is inspected and listed as running.
  let sessions = attachCodexThreadActivity(threads, { now, cache: new Map(), maxThreads: 1 });
  assert.deepEqual(statuses(buildSessionOverview(codexSnapshot(sessions), state, { now })), [["Building", "running"]]);

  // Next refresh: a newer thread takes the only inspection slot, so this one is "unknown".
  const newer = { id: "newer", title: "Newer", path: write("newer", [event(MINUTE, "task_started"), call(1_000, "n1")], 1_000) };
  sessions = attachCodexThreadActivity([...threads, newer], { now, cache: new Map(), maxThreads: 1 });
  assert.equal(sessions[0].activity.state, "unknown");
  assert.deepEqual(statuses(buildSessionOverview(codexSnapshot(sessions), state, { now })), [["Newer", "running"]]);
  buildDashboardViewModel(codexSnapshot(sessions), state, { now, sessionSlots: 2 });
  assert.equal(state.isUnreadFinished("codex:running"), false, "an uninspected thread keeps its running state");

  // Once it is read again and has finished, it is listed as done until viewed.
  fs.appendFileSync(runningFile, `${JSON.stringify({ timestamp: new Date(now - 30_000).toISOString(), type: "event_msg", payload: { type: "task_complete" } })}\n`);
  sessions = attachCodexThreadActivity(threads, { now, cache: new Map() });
  assert.deepEqual(statuses(buildSessionOverview(codexSnapshot(sessions), state, { now })), [["Building", "done"]]);
  assert.equal(state.isUnreadFinished("codex:running"), true);
});
