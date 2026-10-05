"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { readJsonlByteRange, readJsonlTailBytes } = require("../src/collectors/jsonl");
const {
  attachCodexThreadActivity,
  collectCodexAppServer,
  collectCodexSnapshot,
  inferCodexActivity,
  mergeRecentCodexRollouts,
  readCodexThreadTail,
} = require("../src/collectors/codex");

const KB = 1024;
const MB = 1024 * KB;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clock() {
  const now = Date.now();
  return { now, at: (msBeforeNow) => new Date(now - msBeforeNow).toISOString() };
}

function writeJsonl(file, entries, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  if (Number.isFinite(mtimeMs)) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

const event = (timestamp, type) => ({ timestamp, type: "event_msg", payload: { type } });
const prompt = (timestamp, message) => ({ timestamp, type: "event_msg", payload: { type: "user_message", message } });
const call = (timestamp, callId, command = "npm test") => ({
  timestamp,
  type: "response_item",
  payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command }), call_id: callId },
});
const output = (timestamp, callId, bytes) => ({
  timestamp,
  type: "response_item",
  payload: { type: "function_call_output", call_id: callId, output: "y".repeat(bytes) },
});

// One open turn: task_started, a prompt, then `pairs` tool calls with outputs of
// `outputBytes` each, the last output written `lastOutputMsAgo` ago.
function longTurn(at, { pairs, outputBytes, startMsAgo = 20 * 60_000, lastOutputMsAgo = 45_000, withStart = true }) {
  const entries = withStart ? [event(at(startMsAgo), "task_started"), prompt(at(startMsAgo), "Refactor the renderer")] : [];
  for (let index = 0; index < pairs; index += 1) {
    const ms = startMsAgo - index * 1_000;
    entries.push(call(at(ms), `k${index}`, "ls"));
    entries.push(output(at(index === pairs - 1 ? lastOutputMsAgo : ms - 500), `k${index}`, outputBytes));
  }
  return entries;
}

function maxStringLength(value) {
  if (typeof value === "string") return value.length;
  if (!value || typeof value !== "object") return 0;
  return Math.max(0, ...Object.values(value).map(maxStringLength));
}

test("JSONL byte ranges skip a cut first line, keep an aligned one and report where to resume", (t) => {
  const file = path.join(tempDir(t, "flexbar-jsonl-range-"), "lines.jsonl");
  const lines = ["{\"i\":0}", "{\"i\":1}", "{\"i\":2}"];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const lineStart = (index) => lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
  const size = fs.statSync(file).size;

  assert.deepEqual(readJsonlByteRange(file, lineStart(1), size), { entries: [{ i: 1 }, { i: 2 }], nextOffset: size });
  assert.deepEqual(readJsonlByteRange(file, lineStart(1) + 1, size).entries, [{ i: 2 }]);
  assert.deepEqual(readJsonlByteRange(file, lineStart(2) + 1, size - 1), { entries: [], nextOffset: null }, "no line boundary in range");

  // A last line still being written is left for the next read; a complete one without
  // its newline yet is read.
  fs.appendFileSync(file, "{\"i\":3,\"pad\":");
  const partial = readJsonlByteRange(file, size, fs.statSync(file).size);
  assert.deepEqual(partial, { entries: [], nextOffset: size });
  fs.appendFileSync(file, "1}");
  const complete = readJsonlByteRange(file, partial.nextOffset, fs.statSync(file).size);
  assert.deepEqual(complete, { entries: [{ i: 3, pad: 1 }], nextOffset: fs.statSync(file).size });
  fs.appendFileSync(file, "\n{\"i\":4}\n");
  assert.deepEqual(readJsonlByteRange(file, complete.nextOffset, fs.statSync(file).size).entries, [{ i: 4 }]);

  assert.deepEqual(readJsonlTailBytes(file, { maxBytes: 1 * KB, maxLines: 2 }).map((entry) => entry.i), [3, 4]);
});

test("a turn longer than the first byte window still reads as running", (t) => {
  const { now, at } = clock();
  const dir = tempDir(t, "flexbar-codex-long-turn-");
  // ~650 KB since task_started; the model has been thinking for 45 s since the last output.
  const file = writeJsonl(path.join(dir, "long.jsonl"), [
    event(at(3 * 3600_000), "task_started"),
    event(at(3 * 3600_000 - 1_000), "task_complete"),
    ...longTurn(at, { pairs: 40, outputBytes: 16 * KB }),
  ]);
  assert.ok(fs.statSync(file).size > 512 * KB);

  const events = readCodexThreadTail(file, { cache: new Map() });
  assert.equal(events[0].payload.type, "task_started");
  assert.equal(events[0].payload.synthetic, undefined, "the real task_started is found by growing the window");
  assert.equal(events[0].timestamp, at(20 * 60_000));
  assert.equal(inferCodexActivity(events, now).state, "waiting");

  const [thread] = attachCodexThreadActivity([{ id: "long", title: "Long refactor", path: file }], { now, cache: new Map() });
  assert.equal(thread.activity.state, "waiting");
  assert.equal(thread.latestTitle, "Refactor the renderer");
});

test("a turn longer than the largest window is treated as open", (t) => {
  const { now, at } = clock();
  const dir = tempDir(t, "flexbar-codex-huge-turn-");
  const huge = longTurn(at, { pairs: 160, outputBytes: 64 * KB });
  const file = writeJsonl(path.join(dir, "huge.jsonl"), huge);
  assert.ok(fs.statSync(file).size > 9 * MB);

  const events = readCodexThreadTail(file, { cache: new Map() });
  assert.equal(events[0].payload.type, "task_started");
  assert.equal(events[0].payload.synthetic, true);
  assert.equal(inferCodexActivity(events, now).state, "waiting");
  // The open-turn rule still ends it after 30 quiet minutes.
  assert.equal(inferCodexActivity(events, now + 31 * 60_000).state, "idle");
});

test("a newest line larger than the byte window does not empty the tail", (t) => {
  const { now, at } = clock();
  const dir = tempDir(t, "flexbar-codex-giant-line-");
  const screenshot = writeJsonl(path.join(dir, "screenshot.jsonl"), [
    event(at(20_000), "task_started"),
    call(at(5_000), "c1"),
    output(at(1_000), "c1", 3 * MB),
  ]);
  const events = readCodexThreadTail(screenshot, { cache: new Map() });
  assert.deepEqual(events.map((entry) => entry.payload.type), ["task_started", "function_call", "function_call_output"]);
  assert.equal(inferCodexActivity(events, now).state, "waiting");

  // Larger than the largest window: no complete line at all, still an open turn.
  const mtimeMs = now - 2_000;
  const giant = writeJsonl(path.join(dir, "giant.jsonl"), [
    event(at(20_000), "task_started"),
    output(at(2_000), "c1", 9 * MB),
  ], mtimeMs);
  const giantEvents = readCodexThreadTail(giant, { cache: new Map() });
  assert.deepEqual(giantEvents.map((entry) => entry.payload.type), ["task_started"]);
  assert.equal(giantEvents[0].timestamp, new Date(mtimeMs).toISOString());
  assert.equal(inferCodexActivity(giantEvents, now).state, "active");
});

test("cached thread tails keep large strings short without losing approval or titles", (t) => {
  const { now, at } = clock();
  const dir = tempDir(t, "flexbar-codex-compact-");
  const escalated = {
    command: `cat <<'EOF' > big.txt\n${"z".repeat(100 * KB)}\nEOF`,
    sandbox_permissions: "require_escalated",
    justification: "write outside the workspace",
  };
  const file = writeJsonl(path.join(dir, "compact.jsonl"), [
    event(at(60_000), "task_started"),
    prompt(at(60_000), `Write the big fixture\n${"p".repeat(200 * KB)}`),
    call(at(50_000), "c1", "ls"),
    output(at(40_000), "c1", 1 * MB),
    {
      timestamp: at(30_000),
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Planning the fixture" }], encrypted_content: "e".repeat(300 * KB) },
    },
    {
      timestamp: at(2_000),
      type: "response_item",
      payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify(escalated), call_id: "c2" },
    },
  ]);

  const cache = new Map();
  const [thread] = attachCodexThreadActivity([{ id: "c", title: "Compact", path: file }], { now, cache });
  const { events } = cache.get(file);

  assert.ok(events.every((entry) => maxStringLength(entry) <= 64 * KB));
  assert.ok(events[3].payload.output.length <= 1 * KB, "tool output keeps a short prefix");
  assert.ok(events[4].payload.encrypted_content.length <= 1 * KB);
  assert.equal(events[5].payload.arguments.sandbox_permissions, "require_escalated", "large JSON tool input stays readable");
  assert.equal(thread.activity.state, "approval");
  assert.match(thread.activity.action, /^cat <<'EOF' > big\.txt/);
  assert.equal(thread.latestTitle, "Write the big fixture");
});

test("a cached turn is bounded in events and bytes but keeps its start and latest prompt", (t) => {
  const { now, at } = clock();
  const dir = tempDir(t, "flexbar-codex-bounded-");
  const entries = [event(at(10 * 60_000), "task_started"), prompt(at(10 * 60_000), "Keep this prompt")];
  for (let index = 0; index < 1_500; index += 1) {
    entries.push({ timestamp: at(9 * 60_000 - index * 100), type: "event_msg", payload: { type: "token_count", info: null } });
  }
  entries.push(call(at(1_000), "last"));
  const many = readCodexThreadTail(writeJsonl(path.join(dir, "many.jsonl"), entries), { cache: new Map() });
  assert.equal(many.length, 1_000);
  assert.deepEqual(many.slice(0, 2).map((entry) => entry.payload.type), ["task_started", "user_message"]);
  assert.equal(many.at(-1).payload.call_id, "last");
  assert.equal(inferCodexActivity(many, now).state, "tool");

  const big = [event(at(10 * 60_000), "task_started"), prompt(at(10 * 60_000), "Big reasoning")];
  for (let index = 0; index < 60; index += 1) {
    big.push({ timestamp: at(9 * 60_000 - index * 1_000), type: "response_item", payload: { type: "reasoning", summary: [{ text: "r".repeat(60 * KB) }] } });
  }
  const bounded = readCodexThreadTail(writeJsonl(path.join(dir, "big.jsonl"), big), { cache: new Map() });
  const approxBytes = bounded.reduce((sum, entry) => sum + JSON.stringify(entry).length * 2, 0);
  assert.ok(bounded.length < big.length);
  assert.ok(approxBytes <= 2.2 * MB, `kept ~${approxBytes} bytes`);
  assert.deepEqual(bounded.slice(0, 2).map((entry) => entry.payload.type), ["task_started", "user_message"]);
  assert.equal(bounded.at(-1).timestamp, big.at(-1).timestamp);
});

test("unchanged rollouts are not read again and appended bytes are read alone", (t) => {
  const { now, at } = clock();
  const dir = tempDir(t, "flexbar-codex-cache-");
  const file = writeJsonl(path.join(dir, "cached.jsonl"), longTurn(at, { pairs: 30, outputBytes: 16 * KB, lastOutputMsAgo: 10_000 }));
  const cache = new Map();
  const first = readCodexThreadTail(file, { cache });

  let bytesRead = 0;
  const realReadSync = fs.readSync;
  fs.readSync = (...args) => {
    const count = realReadSync(...args);
    bytesRead += count;
    return count;
  };
  t.after(() => {
    fs.readSync = realReadSync;
  });

  assert.equal(readCodexThreadTail(file, { cache }), first, "same mtime + size: cached events");
  const [thread] = attachCodexThreadActivity([{ id: "x", title: "X", path: file }], { now, cache });
  assert.equal(thread.activity.state, "waiting");
  assert.equal(bytesRead, 0);

  fs.appendFileSync(file, `${JSON.stringify(call(at(500), "next", "npm run build"))}\n`);
  const grown = readCodexThreadTail(file, { cache });
  assert.ok(bytesRead > 0 && bytesRead < 1 * KB, `read ${bytesRead} bytes for one appended line`);
  assert.equal(grown.length, first.length + 1);
  assert.equal(grown[0], first[0], "earlier events are kept, not re-parsed");
  assert.equal(inferCodexActivity(grown, now).state, "tool");

  // A new turn replaces the old one in the cache.
  fs.appendFileSync(file, `${JSON.stringify(event(at(200), "task_complete"))}\n${JSON.stringify(event(at(100), "task_started"))}\n`);
  const next = readCodexThreadTail(file, { cache });
  assert.deepEqual(next.map((entry) => entry.payload.type), ["task_started"]);
});

test("the thread cap reads the most recently written rollouts, whatever the list order", (t) => {
  const { now, at } = clock();
  const dir = tempDir(t, "flexbar-codex-cap-");
  // thread/list order: newest created first; the oldest-created thread is the running one.
  const threads = [];
  for (let index = 17; index >= 1; index -= 1) {
    const endMs = index === 5 ? 2_000 : (10 + index) * 60_000;
    const file = writeJsonl(path.join(dir, `t${index}.jsonl`), [
      event(at(endMs + 60_000), "task_started"),
      event(at(endMs), "task_complete"),
    ], now - endMs);
    threads.push({ id: `t${index}`, title: `Task ${index}`, path: file });
  }
  threads.push({
    id: "t0",
    title: "Task 0",
    path: writeJsonl(path.join(dir, "t0.jsonl"), [event(at(100 * 60_000), "task_started"), call(at(20_000), "c1", "cargo build")], now - 20_000),
  });
  threads.push({ id: "old", title: "Old", path: writeJsonl(path.join(dir, "old.jsonl"), [event(at(7 * 3600_000), "task_started")], now - 7 * 3600_000) });

  const result = attachCodexThreadActivity(threads, { now, cache: new Map() });
  const byId = Object.fromEntries(result.map((thread) => [thread.id, thread]));

  assert.equal(byId.t0.activity.state, "tool", "the running thread is inspected although it is listed last");
  assert.equal(byId.t5.activity.detail, "task_complete");
  // 18 threads within the window, 16 inspected: the two least recently written are "unknown", not finished.
  assert.deepEqual(result.filter((thread) => thread.activity && thread.activity.state === "unknown").map((thread) => thread.id), ["t17", "t16"]);
  assert.equal(byId.t15.activity.detail, "task_complete");
  assert.equal(byId.old, threads.at(-1), "rollouts older than the window are not read");
});

test("rollouts written recently but missing from thread/list are merged from disk", (t) => {
  const { now, at } = clock();
  const home = tempDir(t, "flexbar-codex-merge-");
  const dir = path.join(home, "sessions", "2026", "10", "05");
  const id = (n) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const rollout = (n, source, entries, mtimeMsAgo) => writeJsonl(path.join(dir, `rollout-2026-10-05T00-00-00-${id(n)}.jsonl`), [
    { timestamp: at(3 * 86400_000), type: "session_meta", payload: { id: id(n), cwd: `/Users/me/project-${n}`, source } },
    ...entries,
  ], now - mtimeMsAgo);
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify({ id: id(1), thread_name: "Resumed project", updated_at: at(60_000) })}\n`);

  const files = [
    rollout(1, "vscode", [prompt(at(3 * 86400_000), "first prompt"), event(at(60_000), "task_started"), call(at(3_000), "c1")], 3_000),
    rollout(2, "exec", [event(at(5_000), "task_started")], 5_000),
    rollout(3, "cli", [prompt(at(9_000), "The following is the Codex agent history added since your last approval assessment.")], 9_000),
    rollout(4, "cli", [prompt(at(20_000), "Listed thread")], 20_000),
    rollout(5, undefined, [prompt(at(3 * 3600_000), "Older format rollout")], 3 * 3600_000),
    rollout(6, "cli", [prompt(at(8 * 3600_000), "Outside the window")], 8 * 3600_000),
  ];
  const listed = [{ id: id(4), title: "Listed thread", path: files[3], updatedAt: Math.floor((now - 20_000) / 1000) }];

  const merged = mergeRecentCodexRollouts(listed, files, home, { now, metadataCache: new Map() });
  assert.deepEqual(merged.map((thread) => thread.id), [id(1), id(4), id(5)], "exec, internal and old rollouts are left out");
  assert.equal(merged[0].title, "Resumed project");
  assert.equal(merged[0].cwd, "/Users/me/project-1");
  assert.equal(merged[0].path, files[0]);
  assert.equal(merged[2].title, "Older format rollout");

  const [resumed] = attachCodexThreadActivity(merged, { now, cache: new Map() });
  assert.equal(resumed.activity.state, "tool");
});

const FAKE_APP_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const threads = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_THREADS, "utf8"));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(message) + "\\n");
  if (message.id === undefined) return;
  const reply = (body) => process.stdout.write(JSON.stringify({ id: message.id, ...body }) + "\\n");
  if (message.method === "initialize") return reply({ result: {} });
  if (message.method === "thread/list") {
    if (process.env.FAKE_CODEX_REJECT_SORT === "1" && message.params.sortKey) {
      return reply({ error: { code: -32600, message: "Invalid request: unknown variant" } });
    }
    return reply({ result: { data: threads, nextCursor: null } });
  }
  return reply({ error: { code: -32601, message: "unsupported" } });
});
`;

function installFakeAppServer(t, threads, { rejectSort = false } = {}) {
  const dir = tempDir(t, "flexbar-fake-codex-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), FAKE_APP_SERVER, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "threads.json"), JSON.stringify(threads));
  const log = path.join(dir, "requests.jsonl");
  fs.writeFileSync(log, "");

  const saved = ["PATH", "FAKE_CODEX_THREADS", "FAKE_CODEX_LOG", "FAKE_CODEX_REJECT_SORT"].map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_CODEX_THREADS = path.join(dir, "threads.json");
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_REJECT_SORT = rejectSort ? "1" : "0";

  return () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((message) => message.method === "thread/list")
    .map((message) => message.params);
}

const appServerThread = (id, title, updatedAtSeconds, extra = {}) => ({
  id,
  name: title,
  preview: title,
  cwd: "/Users/me/project",
  path: null,
  status: { type: "notLoaded" },
  createdAt: updatedAtSeconds,
  updatedAt: updatedAtSeconds,
  ...extra,
});

test("thread/list asks for the most recently updated threads and retries without sortKey when rejected", { skip: process.platform === "win32" }, async (t) => {
  const seconds = Math.floor(Date.now() / 1000);
  const threads = [appServerThread("a", "Alpha", seconds), appServerThread("b", "", seconds - 60, { preview: "Fix the flaky test\nmore" })];
  const home = tempDir(t, "flexbar-codex-home-");

  const requests = installFakeAppServer(t, threads);
  const sorted = await collectCodexAppServer({ codexHome: home, includeQuota: false, timeoutMs: 10_000 });
  assert.deepEqual(requests(), [{ limit: 20, archived: false, sortKey: "updated_at" }]);
  assert.deepEqual(sorted.threads.map((thread) => thread.title), ["Alpha", "Fix the flaky test"]);
  assert.deepEqual(sorted.errors, []);

  const rejectedRequests = installFakeAppServer(t, threads, { rejectSort: true });
  const fallback = await collectCodexAppServer({ codexHome: home, includeQuota: false, timeoutMs: 10_000 });
  assert.deepEqual(rejectedRequests(), [{ limit: 20, archived: false, sortKey: "updated_at" }, { limit: 20, archived: false }]);
  assert.deepEqual(fallback.threads.map((thread) => thread.id), ["a", "b"]);
  assert.deepEqual(fallback.errors, []);
});

test("a resumed thread missing from thread/list is listed and is the active session", { skip: process.platform === "win32" }, async (t) => {
  const { now, at } = clock();
  const home = tempDir(t, "flexbar-codex-resumed-");
  const dir = path.join(home, "sessions", "2026", "10", "02");
  const id = (n) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const rollout = (n, entries, mtimeMsAgo) => writeJsonl(path.join(dir, `rollout-2026-10-02T00-00-00-${id(n)}.jsonl`), [
    { timestamp: at(3 * 86400_000), type: "session_meta", payload: { id: id(n), cwd: "/Users/me/project", source: "cli" } },
    prompt(at(3 * 86400_000), `Prompt ${n}`),
    ...entries,
  ], now - mtimeMsAgo);

  // Created three days ago, resumed a minute ago and running a command now.
  rollout(0, [event(at(3 * 86400_000 - 5_000), "task_complete"), event(at(60_000), "task_started"), prompt(at(60_000), "Resume it"), call(at(3_000), "c1")], 3_000);
  // The threads thread/list returns: created later, finished long ago.
  const listed = [1, 2, 3].map((n) => {
    const endMsAgo = 2 * 86400_000 - n * 60_000;
    const file = rollout(n, [event(at(endMsAgo), "task_complete")], endMsAgo);
    return appServerThread(id(n), `Prompt ${n}`, Math.floor((now - endMsAgo) / 1000), { path: file });
  }).reverse();
  installFakeAppServer(t, listed);

  const snapshot = await collectCodexSnapshot({
    codexHome: home,
    includeQuota: false,
    includeUsage: false,
    skipOAuthQuota: true,
    appServerTimeoutMs: 10_000,
    now,
    threadTailCache: new Map(),
  });

  const resumed = snapshot.sessions.find((session) => session.id === id(0));
  assert.ok(resumed, "the resumed thread is listed");
  assert.equal(resumed.activity.state, "tool");
  assert.equal(resumed.latestTitle, "Resume it");
  assert.equal(snapshot.activeSession.id, id(0));
  assert.equal(snapshot.activity.state, "tool");
  for (const session of snapshot.sessions.filter((item) => item.id !== id(0))) {
    assert.ok(!session.activity || session.activity.state === "idle", `${session.id} is not running`);
  }
});

test("the newest rollout's activity never lands on another session", { skip: process.platform === "win32" }, async (t) => {
  const { now, at } = clock();
  const home = tempDir(t, "flexbar-codex-internal-latest-");
  const dir = path.join(home, "sessions", "2026", "10", "05");
  const finishedId = "019a0000-0000-7000-8000-000000000001";
  const reviewId = "019a0000-0000-7000-8000-000000000002";
  const finished = writeJsonl(path.join(dir, `rollout-2026-10-05T00-00-00-${finishedId}.jsonl`), [
    { timestamp: at(9 * 3600_000), type: "session_meta", payload: { id: finishedId, cwd: "/Users/me/project", source: "cli" } },
    event(at(8 * 3600_000), "task_complete"),
  ], now - 8 * 3600_000);
  // An internal approval review that is waiting on an escalated command right now.
  writeJsonl(path.join(dir, `rollout-2026-10-05T01-00-00-${reviewId}.jsonl`), [
    { timestamp: at(10_000), type: "session_meta", payload: { id: reviewId, cwd: "/Users/me/project", source: "cli" } },
    event(at(10_000), "task_started"),
    prompt(at(10_000), "The following is the Codex agent history added since your last approval assessment."),
    {
      timestamp: at(1_000),
      type: "response_item",
      payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "rm -rf build", sandbox_permissions: "require_escalated" }), call_id: "c1" },
    },
  ], now - 1_000);
  installFakeAppServer(t, [appServerThread(finishedId, "Finished work", Math.floor((now - 8 * 3600_000) / 1000), { path: finished })]);

  const snapshot = await collectCodexSnapshot({
    codexHome: home,
    includeQuota: false,
    includeUsage: false,
    skipOAuthQuota: true,
    appServerTimeoutMs: 10_000,
    now,
    threadTailCache: new Map(),
  });

  assert.deepEqual(snapshot.sessions.map((session) => session.id), [finishedId]);
  assert.equal(snapshot.activeSession.id, finishedId);
  assert.notEqual(snapshot.activeSession.activity && snapshot.activeSession.activity.state, "approval");
  assert.equal(snapshot.activity.state, "idle", "the provider activity is the active session's own");
});

test("Codex open calls age out: tools after 30 min, approvals after 6 h", () => {
  const now = Date.parse("2026-05-13T12:00:00.000Z");
  const at = (msBefore) => new Date(now - msBefore).toISOString();
  const turn = (msBefore, args) => [
    { timestamp: at(msBefore + 1_000), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(msBefore), type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify(args), call_id: "c1" } },
  ];
  const tool = { command: "npm run build" };
  const escalated = { command: "rm -rf dist", sandbox_permissions: "require_escalated" };

  assert.equal(inferCodexActivity(turn(29 * 60_000, tool), now).state, "tool");
  assert.equal(inferCodexActivity(turn(31 * 60_000, tool), now).state, "idle");
  assert.equal(inferCodexActivity(turn(5 * 3_600_000, escalated), now).state, "approval");
  assert.equal(inferCodexActivity(turn(7 * 3_600_000, escalated), now).state, "idle");
});

test("the thread read cap limits fresh reads only: unchanged cached rollouts stay inspected", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-codex-cap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const at = (msBefore) => new Date(now - msBefore).toISOString();
  const write = (name, events, msBefore) => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    fs.utimesSync(file, new Date(now - msBefore), new Date(now - msBefore));
    return { id: name, title: name, path: file };
  };
  const approval = write("approval", [
    { timestamp: at(3 * 3_600_000 + 1_000), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(3 * 3_600_000), type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "deploy", sandbox_permissions: "require_escalated" }), call_id: "a" } },
  ], 3 * 3_600_000);
  const newer = Array.from({ length: 3 }, (_, index) => write(`done${index}`, [
    { timestamp: at(60_000 + index), type: "event_msg", payload: { type: "task_complete" } },
  ], 60_000 + index));

  const cache = new Map();
  const threads = [...newer, approval];
  const first = attachCodexThreadActivity(threads, { now, cache, maxThreads: 3 });
  assert.equal(first[3].activity.state, "unknown", "first refresh: past the read cap");
  const second = attachCodexThreadActivity(threads, { now, cache, maxThreads: 3 });
  assert.equal(second[3].activity.state, "approval", "next refresh reads it; the other three come from the cache");
  const third = attachCodexThreadActivity(threads, { now, cache, maxThreads: 3 });
  assert.equal(third[3].activity.state, "approval", "and it stays inspected while unchanged");
  assert.ok(cache.has(approval.path));
});
