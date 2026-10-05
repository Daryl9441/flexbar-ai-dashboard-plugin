"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectClaudeSnapshot,
  normalizeClaudeHookActivity,
  readClaudeBridgeSnapshot,
} = require("../src/collectors/claude");
const { buildSessionOverview, createDashboardState } = require("../src/dashboard/viewModel");

const NOW = Date.parse("2026-05-13T08:30:00.000Z");
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3600_000;
const iso = (msBeforeNow) => new Date(NOW - msBeforeNow).toISOString();

const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION_B = "bbbbbbbb-0000-4000-8000-000000000002";
const SESSION_C = "cccccccc-0000-4000-8000-000000000003";
const PROJECT = "-Users-me-example";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-activity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = path.join(dir, "projects");
  fs.mkdirSync(projects, { recursive: true });
  return { dir, projects, bridgePath: path.join(dir, "claude-events.jsonl") };
}

function writeTranscript(projects, sessionId, entries, options = {}) {
  const dir = options.subagent
    ? path.join(projects, PROJECT, sessionId, "subagents")
    : path.join(projects, PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, options.subagent ? `${options.subagent}.jsonl` : `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify({
    sessionId,
    cwd: "/Users/me/example",
    isSidechain: Boolean(options.subagent),
    ...entry,
  })).join("\n") + "\n");
  return file;
}

const bridgeLine = (record) => JSON.stringify(record) + "\n";
function writeBridge(bridgePath, records) {
  fs.writeFileSync(bridgePath, records.map(bridgeLine).join(""));
}
function appendBridge(bridgePath, records) {
  fs.appendFileSync(bridgePath, records.map(bridgeLine).join(""));
}

// Records as the recorder that claudeBridgeInstall.js installs writes them.
function hook(msBeforeNow, hookType, sessionId, data = {}) {
  return {
    timestamp: iso(msBeforeNow),
    source: "hook",
    type: hookType,
    hook_type: hookType,
    data: {
      session_id: sessionId,
      transcript_path: `/Users/me/.claude/projects/${PROJECT}/${sessionId}.jsonl`,
      cwd: "/Users/me/example",
      hook_event_name: hookType,
      ...data,
    },
  };
}
function statusLine(msBeforeNow, sessionId) {
  return {
    timestamp: iso(msBeforeNow),
    source: "statusline",
    type: "statusline",
    hook_type: null,
    data: { session_id: sessionId, cwd: "/Users/me/example", model: { display_name: "Opus" } },
  };
}

const prompt = (msBeforeNow, text) => ({
  type: "user",
  timestamp: iso(msBeforeNow),
  message: { role: "user", content: text },
});
const reply = (msBeforeNow, text) => ({
  type: "assistant",
  timestamp: iso(msBeforeNow),
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolUse = (msBeforeNow, id, name = "Bash", input = { command: "npm run build" }) => ({
  type: "assistant",
  timestamp: iso(msBeforeNow),
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (msBeforeNow, id, content = "ok") => ({
  type: "user",
  timestamp: iso(msBeforeNow),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});
const interrupted = (msBeforeNow, text = "[Request interrupted by user for tool use]") => ({
  type: "user",
  timestamp: iso(msBeforeNow),
  message: { role: "user", content: [{ type: "text", text }] },
});

async function collect(home, options = {}) {
  return collectClaudeSnapshot({
    projectRoots: [home.projects],
    bridgePath: home.bridgePath,
    includeUsage: false,
    includeQuota: false,
    now: NOW,
    ...options,
  });
}

function sessionById(snapshot, id) {
  const session = snapshot.sessions.find((item) => item.id === id);
  assert.ok(session, `session ${id} listed`);
  return session;
}

function overviewStatuses(snapshot) {
  const overview = buildSessionOverview({ providers: { claude: snapshot } }, createDashboardState(), { now: NOW });
  return overview.items.map((item) => [item.title, item.status]);
}

test("a Claude session whose last hook is Stop is done, although its statusline keeps refreshing", async (t) => {
  const home = tempHome(t);
  writeTranscript(home.projects, SESSION_A, [
    prompt(11 * MINUTE, "Fix the login bug"),
    toolUse(10.5 * MINUTE, "tool-1"),
    toolResult(10.2 * MINUTE, "tool-1"),
    reply(10 * MINUTE, "Fixed."),
  ]);
  writeBridge(home.bridgePath, [
    hook(11 * MINUTE, "UserPromptSubmit", SESSION_A, { prompt: "Fix the login bug" }),
    hook(10.5 * MINUTE, "PreToolUse", SESSION_A, { tool_name: "Bash", tool_input: { command: "npm test" } }),
    hook(10.2 * MINUTE, "PostToolUse", SESSION_A, { tool_name: "Bash" }),
    hook(10 * MINUTE, "Stop", SESSION_A, { stop_hook_active: false }),
    statusLine(5 * SECOND, SESSION_A),
  ]);

  const snapshot = await collect(home);
  const session = sessionById(snapshot, SESSION_A);

  assert.equal(session.activity.state, "idle");
  assert.equal(session.activity.detail, "stop");
  assert.equal(snapshot.activeSession.id, SESSION_A);
  assert.deepEqual(overviewStatuses(snapshot), [["Fix the login bug", "done"]]);
});

test("Claude notifications: idle_prompt ends the turn, permission prompts await approval, others change nothing", () => {
  const notification = (data) => normalizeClaudeHookActivity(hook(0, "Notification", SESSION_A, data), NOW);

  assert.equal(notification({ message: "Claude is waiting for your input", notification_type: "idle_prompt" }).state, "idle");
  assert.equal(notification({ message: "Claude is waiting for your input" }).state, "idle", "older Claude Code: no notification_type");

  const approval = notification({ message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" });
  assert.equal(approval.state, "approval");
  assert.equal(approval.detail, "Bash");
  assert.equal(notification({ message: "Example server requests input", notification_type: "elicitation_dialog" }).state, "approval");

  assert.equal(notification({ message: "Signed in", notification_type: "auth_success" }), null);
  assert.equal(normalizeClaudeHookActivity(hook(0, "SubagentStop", SESSION_A, { agent_id: "agent-1" }), NOW), null);
  assert.equal(normalizeClaudeHookActivity(hook(0, "SessionStart", SESSION_A, { source: "compact" }), NOW), null);
  assert.equal(normalizeClaudeHookActivity(hook(0, "SessionStart", SESSION_A, { source: "startup" }), NOW).state, "idle");
  assert.equal(normalizeClaudeHookActivity(hook(0, "StopFailure", SESSION_A, { error: "rate_limit" }), NOW).state, "idle");
  assert.equal(normalizeClaudeHookActivity(hook(0, "PostToolUseFailure", SESSION_A, { tool_name: "Bash", is_interrupt: true }), NOW).state, "idle");
  assert.equal(normalizeClaudeHookActivity(hook(0, "PermissionRequest", SESSION_A, { tool_name: "Bash", tool_input: { command: "rm -rf build" } }), NOW).state, "approval");
});

test("each Claude session gets the hook activity recorded under its own session_id", async (t) => {
  const home = tempHome(t);
  writeTranscript(home.projects, SESSION_A, [
    prompt(70 * SECOND, "Build the release"),
    toolUse(60 * SECOND, "tool-a", "Bash", { command: "npm run build" }),
  ]);
  writeTranscript(home.projects, SESSION_B, [
    prompt(20 * MINUTE, "Write the docs"),
    reply(19 * MINUTE, "Docs written."),
  ]);
  writeTranscript(home.projects, SESSION_C, [
    prompt(4 * MINUTE, "Rename a variable"),
    reply(3 * MINUTE, "Renamed."),
  ]);
  // Interleaved: B's statusline is the newest record, A's hooks are older.
  writeBridge(home.bridgePath, [
    hook(20 * MINUTE, "UserPromptSubmit", SESSION_B),
    hook(19 * MINUTE, "Stop", SESSION_B),
    hook(70 * SECOND, "UserPromptSubmit", SESSION_A),
    statusLine(65 * SECOND, SESSION_B),
    hook(60 * SECOND, "PreToolUse", SESSION_A, { tool_name: "Bash", tool_input: { command: "npm run build" } }),
    statusLine(30 * SECOND, SESSION_A),
    statusLine(2 * SECOND, SESSION_B),
  ]);

  const snapshot = await collect(home);

  const a = sessionById(snapshot, SESSION_A);
  assert.equal(a.activity.state, "tool");
  assert.equal(a.activity.detail, "Bash");
  assert.equal(a.activity.source, "claude_hooks");
  const b = sessionById(snapshot, SESSION_B);
  assert.equal(b.activity.state, "idle");
  assert.equal(b.activity.detail, "stop");
  // C has no hooks: its own transcript decides, not another session's hook.
  const c = sessionById(snapshot, SESSION_C);
  assert.equal(c.activity.state, "idle");
  assert.equal(c.activity.source, "claude_jsonl");

  assert.equal(snapshot.activeSession.id, SESSION_B, "newest statusline names the session in front of the user");
  assert.deepEqual(overviewStatuses(snapshot), [
    ["Build the release", "running"],
    ["Rename a variable", "done"],
    ["Write the docs", "done"],
  ]);
});

test("Claude bridge reads only appended records and notices a rewritten file", async (t) => {
  const home = tempHome(t);
  writeTranscript(home.projects, SESSION_A, [prompt(2 * MINUTE, "Run the tests"), toolUse(90 * SECOND, "tool-1")]);
  writeTranscript(home.projects, SESSION_B, [prompt(2 * MINUTE, "Lint the code"), toolUse(90 * SECOND, "tool-2")]);
  writeBridge(home.bridgePath, [
    hook(90 * SECOND, "PreToolUse", SESSION_A, { tool_name: "Bash" }),
    hook(90 * SECOND, "PreToolUse", SESSION_B, { tool_name: "Bash" }),
  ]);

  let snapshot = await collect(home);
  assert.equal(sessionById(snapshot, SESSION_A).activity.state, "tool");
  assert.equal(sessionById(snapshot, SESSION_B).activity.state, "tool");

  // A half-written line is left for the next read.
  fs.appendFileSync(home.bridgePath, bridgeLine(hook(10 * SECOND, "Stop", SESSION_A)) + "{\"timestamp\":");
  snapshot = await collect(home);
  assert.equal(sessionById(snapshot, SESSION_A).activity.state, "idle");
  assert.equal(sessionById(snapshot, SESSION_B).activity.state, "tool", "B keeps its own PreToolUse");

  fs.appendFileSync(home.bridgePath, `"${iso(5 * SECOND)}","source":"hook","type":"Stop","hook_type":"Stop","data":{"session_id":"${SESSION_B}"}}\n`);
  snapshot = await collect(home);
  assert.equal(sessionById(snapshot, SESSION_B).activity.state, "idle", "completed line is read");

  // Rewritten in place (same inode, different content): read again from scratch.
  writeBridge(home.bridgePath, [
    hook(3 * SECOND, "UserPromptSubmit", SESSION_A),
    hook(3 * SECOND, "UserPromptSubmit", SESSION_B),
  ]);
  snapshot = await collect(home);
  assert.equal(sessionById(snapshot, SESSION_A).activity.state, "working");
  assert.equal(sessionById(snapshot, SESSION_B).activity.state, "working");
});

test("Claude bridge snapshot reads a bounded tail of a large bridge file", (t) => {
  const home = tempHome(t);
  const records = [];
  for (let index = 0; index < 400; index += 1) {
    records.push(statusLine(400 * SECOND - index * SECOND, index % 2 ? SESSION_A : SESSION_B));
  }
  records.push(hook(SECOND, "PreToolUse", SESSION_A, { tool_name: "Read", tool_input: { file_path: "/Users/me/example/a.js" } }));
  writeBridge(home.bridgePath, records);

  const snapshot = readClaudeBridgeSnapshot(home.bridgePath, { now: NOW, maxBytes: 4_000 });

  assert.equal(snapshot.sessions.get(SESSION_A).activity.state, "tool");
  assert.equal(snapshot.sessions.get(SESSION_A).activity.detail, "Read");
  assert.equal(snapshot.sessions.get(SESSION_B).status.sessionId, SESSION_B);
  assert.equal(snapshot.status.sessionId, SESSION_A);
  assert.equal(snapshot.latestEventAt, iso(SECOND));
});

test("a Claude tool call without its result keeps a session running, up to 30 minutes", async (t) => {
  const home = tempHome(t);
  // Hookless: a long build started 2 minutes ago, nothing written since.
  writeTranscript(home.projects, SESSION_A, [
    prompt(130 * SECOND, "Build the release"),
    toolUse(2 * MINUTE, "tool-1", "Bash", { command: "npm run build" }),
  ]);
  // Killed in the middle of a tool call 2 hours ago.
  writeTranscript(home.projects, SESSION_B, [
    prompt(2 * HOUR + MINUTE, "Run the migration"),
    toolUse(2 * HOUR, "tool-2", "Bash", { command: "npm run migrate" }),
  ]);

  const snapshot = await collect(home);

  const a = sessionById(snapshot, SESSION_A);
  assert.equal(a.activity.state, "tool");
  assert.equal(a.activity.detail, "Bash");
  assert.equal(a.activity.action, "npm run build");
  const b = sessionById(snapshot, SESSION_B);
  assert.equal(b.activity.state, "idle");
  assert.deepEqual(overviewStatuses(snapshot), [["Build the release", "running"]]);
});

test("a Claude hook saying the turn runs goes stale after 30 minutes without any event", async (t) => {
  const home = tempHome(t);
  writeTranscript(home.projects, SESSION_A, [prompt(41 * MINUTE, "Long job"), toolUse(40 * MINUTE, "tool-1")]);
  writeTranscript(home.projects, SESSION_B, [prompt(41 * MINUTE, "Longer job"), toolUse(40 * MINUTE, "tool-2", "Agent", { description: "Explore" })]);
  // B's subagent is still writing its own transcript.
  writeTranscript(home.projects, SESSION_B, [
    prompt(39 * MINUTE, "Explore the code base"),
    toolUse(20 * SECOND, "sub-tool-1", "Grep", { pattern: "TODO" }),
  ], { subagent: "agent-1" });
  writeBridge(home.bridgePath, [
    hook(40 * MINUTE, "PreToolUse", SESSION_A, { tool_name: "Bash" }),
    hook(40 * MINUTE, "PreToolUse", SESSION_B, { tool_name: "Agent" }),
  ]);

  const snapshot = await collect(home);

  assert.equal(sessionById(snapshot, SESSION_A).activity.state, "idle");
  assert.equal(sessionById(snapshot, SESSION_B).activity.state, "tool", "subagent activity keeps the parent fresh");
});

test("a Claude permission prompt stays awaiting approval for hours, then expires", async (t) => {
  const home = tempHome(t);
  writeTranscript(home.projects, SESSION_A, [prompt(3 * HOUR + MINUTE, "Install deps"), toolUse(3 * HOUR, "tool-1", "Bash", { command: "npm install" })]);
  writeTranscript(home.projects, SESSION_B, [prompt(7 * HOUR + MINUTE, "Delete build"), toolUse(7 * HOUR, "tool-2", "Bash", { command: "rm -rf build" })]);
  writeBridge(home.bridgePath, [
    hook(7 * HOUR, "PermissionRequest", SESSION_B, { tool_name: "Bash", tool_input: { command: "rm -rf build" } }),
    hook(3 * HOUR, "PermissionRequest", SESSION_A, { tool_name: "Bash", tool_input: { command: "npm install" } }),
    hook(3 * HOUR - 6 * SECOND, "Notification", SESSION_A, {
      message: "Claude needs your permission to use Bash",
      notification_type: "permission_prompt",
    }),
  ]);

  const snapshot = await collect(home);

  const a = sessionById(snapshot, SESSION_A);
  assert.equal(a.activity.state, "approval");
  assert.equal(a.activity.action, "npm install", "the PermissionRequest's tool input is kept");
  assert.equal(sessionById(snapshot, SESSION_B).activity.state, "idle");
  assert.deepEqual(overviewStatuses(snapshot), [["Install deps", "approval"]]);
});

test("an interrupted Claude turn is done although no Stop hook fired", async (t) => {
  const home = tempHome(t);
  writeTranscript(home.projects, SESSION_A, [
    prompt(3 * MINUTE, "Refactor the parser"),
    toolUse(2 * MINUTE, "tool-1", "Bash", { command: "npm test" }),
    toolResult(100 * SECOND, "tool-1", "The user doesn't want to proceed with this tool use. The tool use was rejected."),
    interrupted(100 * SECOND),
  ]);
  writeTranscript(home.projects, SESSION_B, [
    prompt(20 * SECOND, "Explain the code"),
    reply(15 * SECOND, "It parses"),
    interrupted(10 * SECOND, "[Request interrupted by user]"),
  ]);
  writeBridge(home.bridgePath, [
    hook(2 * MINUTE, "PermissionRequest", SESSION_A, { tool_name: "Bash", tool_input: { command: "npm test" } }),
  ]);

  const snapshot = await collect(home);

  assert.equal(sessionById(snapshot, SESSION_A).activity.state, "idle");
  assert.equal(sessionById(snapshot, SESSION_A).activity.detail, "interrupted");
  assert.equal(sessionById(snapshot, SESSION_B).activity.state, "idle", "hookless session interrupted while streaming");
});

test("a Claude turn the hooks did not see is read from the transcript", async (t) => {
  const home = tempHome(t);
  writeTranscript(home.projects, SESSION_A, [
    prompt(2 * HOUR, "Old question"),
    reply(2 * HOUR - MINUTE, "Old answer"),
    prompt(20 * SECOND, "New question"),
    toolUse(10 * SECOND, "tool-1", "Read", { file_path: "/Users/me/example/a.js" }),
  ]);
  writeBridge(home.bridgePath, [hook(2 * HOUR - MINUTE, "Stop", SESSION_A)]);

  const snapshot = await collect(home);
  const session = sessionById(snapshot, SESSION_A);

  assert.equal(session.activity.state, "tool");
  assert.equal(session.activity.detail, "Read");
  assert.equal(session.latestTitle, "New question");
});

test("a Claude session whose turn ended keeps running while background subagents write", async (t) => {
  const home = tempHome(t);
  for (const id of [SESSION_A, SESSION_B]) {
    writeTranscript(home.projects, id, [prompt(11 * MINUTE, `Start background job ${id.slice(0, 1)}`), reply(10 * MINUTE, "Started.")]);
  }
  writeTranscript(home.projects, SESSION_A, [prompt(10 * MINUTE, "Background task"), reply(5 * SECOND, "Still working")], { subagent: "agent-1" });
  writeTranscript(home.projects, SESSION_B, [prompt(10 * MINUTE, "Background task"), reply(2 * MINUTE, "Finished")], { subagent: "agent-1" });
  writeBridge(home.bridgePath, [hook(10 * MINUTE, "Stop", SESSION_A), hook(10 * MINUTE, "Stop", SESSION_B)]);

  const snapshot = await collect(home);

  assert.equal(sessionById(snapshot, SESSION_A).activity.state, "working");
  assert.equal(sessionById(snapshot, SESSION_A).activity.detail, "subagent");
  assert.equal(sessionById(snapshot, SESSION_B).activity.state, "idle");

  fs.writeFileSync(home.bridgePath, "");
  const hookless = await collect(home);
  assert.equal(sessionById(hookless, SESSION_A).activity.state, "working");
  assert.equal(sessionById(hookless, SESSION_B).activity.state, "idle");
});

test("Claude sessions are still listed when newer subagent transcripts fill the scanned files", async (t) => {
  const home = tempHome(t);
  const setMtime = (file, msBeforeNow) => {
    const time = new Date(NOW - msBeforeNow);
    fs.utimesSync(file, time, time);
  };
  setMtime(writeTranscript(home.projects, SESSION_A, [prompt(5 * MINUTE, "Plan the release"), toolUse(4 * MINUTE, "tool-1", "Agent")]), 4 * MINUTE);
  setMtime(writeTranscript(home.projects, SESSION_B, [prompt(12 * MINUTE, "Fix the flaky test"), reply(10 * MINUTE, "Fixed.")]), 10 * MINUTE);
  // A long background workflow: the parent transcript was last written 8 hours ago.
  setMtime(writeTranscript(home.projects, SESSION_C, [prompt(8 * HOUR, "Run the nightly workflow"), reply(8 * HOUR, "Started.")]), 8 * HOUR);
  for (let index = 0; index < 3; index += 1) {
    setMtime(writeTranscript(home.projects, SESSION_A, [
      prompt(3 * MINUTE, `Subagent ${index}`),
      reply((index + 1) * SECOND, "Working"),
    ], { subagent: `agent-${index}` }), (index + 1) * SECOND);
  }
  setMtime(writeTranscript(home.projects, SESSION_C, [
    prompt(8 * HOUR, "Nightly step"),
    reply(10 * SECOND, "Working"),
  ], { subagent: "agent-nightly" }), 10 * SECOND);

  const snapshot = await collect(home, { maxFiles: 4 });

  assert.deepEqual(snapshot.sessions.map((session) => session.id).sort(), [SESSION_A, SESSION_B, SESSION_C]);
  assert.ok(snapshot.sessions.every((session) => !session.internal));
  assert.equal(sessionById(snapshot, SESSION_A).activity.state, "tool");
  assert.deepEqual(overviewStatuses(snapshot), [
    ["Plan the release", "running"],
    ["Run the nightly workflow", "running"],
    ["Fix the flaky test", "done"],
  ]);
});

test("Claude subagent transcripts are not sessions and do not supply titles or open tool calls", async (t) => {
  const home = tempHome(t);
  writeTranscript(home.projects, SESSION_A, [
    { type: "user", timestamp: iso(10 * MINUTE), isMeta: true, message: { role: "user", content: "Caveat: local command output follows." } },
    prompt(10 * MINUTE, "<command-name>/model</command-name>"),
    prompt(9 * MINUTE, "Audit the dependencies"),
    toolUse(8 * MINUTE, "tool-1", "Agent", { description: "Audit" }),
    toolResult(2 * MINUTE, "tool-1", "No issues"),
    reply(90 * SECOND, "All dependencies are fine."),
  ]);
  // The subagent was killed mid tool call; its file is newer than the parent's.
  writeTranscript(home.projects, SESSION_A, [
    prompt(8 * MINUTE, "Subagent task prompt"),
    toolUse(3 * MINUTE, "sub-tool-1", "Bash", { command: "npm audit" }),
  ], { subagent: "agent-1" });

  const snapshot = await collect(home);

  assert.equal(snapshot.sessions.length, 1);
  const session = sessionById(snapshot, SESSION_A);
  assert.equal(session.internal, undefined);
  assert.equal(session.title, "Audit the dependencies");
  assert.equal(session.project, PROJECT);
  assert.equal(session.activity.state, "idle");
});
