"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { formatMonitorSnapshot } = require("../src/prototype/monitorFormat");
const {
  DEFAULT_INTERVAL_MS,
  DEFAULT_USAGE_INTERVAL_MS,
  applyUsageCache,
  captureUsageCache,
  readIntervalMs,
  readUsageIntervalMs,
} = require("../src/prototype/print-snapshot");

test("prototype monitor defaults to a two second interval", () => {
  assert.equal(DEFAULT_INTERVAL_MS, 2_000);
  assert.equal(readIntervalMs([]), 2_000);
  assert.equal(readIntervalMs(["--interval", "bad"]), 2_000);
  assert.equal(readIntervalMs(["--interval", "750"]), 750);
});

test("prototype monitor refreshes usage on a slower interval", () => {
  assert.equal(DEFAULT_USAGE_INTERVAL_MS, 30_000);
  assert.equal(readUsageIntervalMs([]), 30_000);
  assert.equal(readUsageIntervalMs(["--usage-interval", "bad"]), 30_000);
  assert.equal(readUsageIntervalMs(["--usage-interval", "10000"]), 10_000);
});

test("prototype monitor reuses cached usage and quota on fast session refreshes", () => {
  const fullSnapshot = {
    providers: {
      codex: {
        usage: { latestTurn: { totalTokens: 123 } },
        quota: { limits: [{ label: "primary", usedPercent: 8 }] },
        sessions: [{ id: "s1", usage: { latestTurn: { totalTokens: 123 } } }],
        activeSession: { id: "s1", usage: { latestTurn: { totalTokens: 123 } } },
      },
    },
  };
  const fastSnapshot = {
    providers: {
      codex: {
        usage: null,
        quota: null,
        sessions: [{ id: "s1", usage: null }],
        activeSession: { id: "s1", usage: null },
      },
    },
  };

  applyUsageCache(fastSnapshot, captureUsageCache(fullSnapshot));

  assert.equal(fastSnapshot.providers.codex.usage.latestTurn.totalTokens, 123);
  assert.equal(fastSnapshot.providers.codex.quota.limits[0].usedPercent, 8);
  assert.equal(fastSnapshot.providers.codex.sessions[0].usage.latestTurn.totalTokens, 123);
  assert.equal(fastSnapshot.providers.codex.activeSession.usage.latestTurn.totalTokens, 123);
});

test("monitor formatter prints session title, status, and current action only", () => {
  const output = formatMonitorSnapshot({
    collectedAt: "2026-05-13T09:00:00.000Z",
    elapsedMs: 12,
    providers: {
      codex: {
        activity: { state: "tool", detail: "shell_command", action: "node --test test/*.test.js", lastEventAt: "2026-05-13T08:59:59.000Z" },
        sessions: [
          { id: "codex-1", title: "Build dashboard", cwd: "C:\\repo", updatedAt: 1778660000, source: "codex_app_server", activity: { state: "tool", detail: "shell_command", action: "node --test test/*.test.js" }, usage: { latestTurn: { totalTokens: 1234 } } },
          { id: "codex-archived", title: "Archived work", archived: true, activity: { state: "idle" } },
        ],
        usage: { latestTurn: { totalTokens: 1234 }, observedTokenEvents: 2 },
        quota: { limits: [{ label: "5h", usedPercent: 42, resetAt: "2026-05-13T10:00:00Z" }] },
        fileStats: { sessionFiles: 3 },
        source: { latestSessionFile: "latest.jsonl", appServer: { available: true, errors: [] } },
      },
    },
  });

  assert.match(output, /AI session monitor/);
  assert.match(output, /Codex/);
  assert.match(output, /总用量 1\.2k/);
  assert.match(output, /订阅用量 5小时 42%/);
  assert.match(output, /Build dashboard/);
  assert.match(output, /运行中/);
  assert.match(output, /正在运行命令: node --test/);
  assert.match(output, /tokens 1\.2k/);
  assert.doesNotMatch(output, /Archived work/);
  assert.doesNotMatch(output, /Usage:/);
  assert.doesNotMatch(output, /Quota:/);
  assert.doesNotMatch(output, /Source:/);
});

test("monitor formatter deduplicates Codex quota and formats reset epochs", () => {
  const output = formatMonitorSnapshot({
    collectedAt: "2026-05-13T09:00:00.000Z",
    providers: {
      codex: {
        sessions: [],
        quota: {
          limits: [
            { label: "primary", usedPercent: 6, resetAt: 1778696068, windowSeconds: 18000 },
            { label: "secondary", usedPercent: 8, resetAt: 1779189630, windowSeconds: 604800 },
            { label: "codex.primary", usedPercent: 6, resetAt: 1778696068, windowSeconds: 18000 },
            { label: "codex_bengalfox.primary", usedPercent: 0, resetAt: 1778699999, windowSeconds: 18000 },
          ],
        },
      },
    },
  });

  assert.match(output, /订阅用量 5小时 6%/);
  assert.match(output, /每周 8%/);
  assert.doesNotMatch(output, /codex\.primary/);
  assert.doesNotMatch(output, /0%/);
  assert.doesNotMatch(output, /1778696068/);
});

test("monitor formatter maps common tool activity to Chinese progress text", () => {
  const snapshot = {
    collectedAt: "2026-05-13T09:00:00.000Z",
    providers: {
      codex: {
        activeSession: { id: "s1" },
        activity: { state: "thinking", detail: "reasoning", action: "planning files" },
        sessions: [
          { id: "s1", title: "Thinking task", activity: { state: "thinking", detail: "reasoning" } },
          { id: "s2", title: "Shell task", activity: { state: "tool", detail: "shell_command", action: "npm test" } },
          { id: "s3", title: "Done task" },
        ],
      },
    },
  };

  const output = formatMonitorSnapshot(snapshot);

  assert.match(output, /Thinking task \| 运行中 \| 正在思考/);
  assert.match(output, /Shell task \| 已完成 \| 已完成/);
  assert.match(output, /Done task \| 已完成 \| 已完成/);

  const searching = formatMonitorSnapshot({
    collectedAt: "2026-05-13T09:00:00.000Z",
    providers: {
      codex: {
        activeSession: { id: "s1" },
        sessions: [{ id: "s1", title: "Search task", activity: { state: "tool", detail: "web_search", action: "codex app-server" } }],
      },
    },
  });
  assert.match(searching, /Search task \| 运行中 \| 正在搜索: codex app-server/);
});

test("monitor formatter renders planning activity as planning", () => {
  const output = formatMonitorSnapshot({
    collectedAt: "2026-05-13T09:00:00.000Z",
    providers: {
      codex: {
        activeSession: { id: "s1" },
        sessions: [
          {
            id: "s1",
            title: "Planning task",
            activity: { state: "planning", detail: "planning", action: "planning..." },
          },
        ],
      },
    },
  });

  assert.match(output, /Planning task/);
  assert.match(output, /planning\.\.\./);
});

test("monitor formatter renders completed tool output with tool context", () => {
  const output = formatMonitorSnapshot({
    collectedAt: "2026-05-13T09:00:00.000Z",
    providers: {
      codex: {
        activeSession: { id: "s1" },
        sessions: [
          {
            id: "s1",
            title: "Output task",
            activity: { state: "waiting", detail: "shell_command", action: "rg collectCodex src" },
          },
        ],
      },
    },
  });

  assert.match(output, /Output task/);
  assert.match(output, /\u8fd0\u884c\u4e2d/);
  assert.match(output, /\u521a\u5b8c\u6210\u8fd0\u884c\u547d\u4ee4: rg collectCodex src/);
  assert.doesNotMatch(output, /planning\.\.\./);
});

test("monitor formatter labels unknown tools and MCP tools explicitly", () => {
  const output = formatMonitorSnapshot({
    collectedAt: "2026-05-13T09:00:00.000Z",
    providers: {
      codex: {
        activeSession: { id: "s1" },
        sessions: [
          {
            id: "s1",
            title: "MCP task",
            activity: { state: "tool", detail: "mcp__node_repl__js", action: "inspect state" },
          },
        ],
      },
    },
  });
  const custom = formatMonitorSnapshot({
    collectedAt: "2026-05-13T09:00:00.000Z",
    providers: {
      codex: {
        activeSession: { id: "s1" },
        sessions: [
          {
            id: "s1",
            title: "Tool task",
            activity: { state: "tool", detail: "custom_tool", action: "do work" },
          },
        ],
      },
    },
  });

  assert.match(output, /\u6b63\u5728\u4f7f\u7528 MCP mcp__node_repl__js: inspect state/);
  assert.match(custom, /\u6b63\u5728\u4f7f\u7528\u5de5\u5177 custom_tool: do work/);
});

test("monitor formatter renders approval activity as waiting for approval", () => {
  const output = formatMonitorSnapshot({
    collectedAt: "2026-05-13T09:00:00.000Z",
    providers: {
      codex: {
        activeSession: { id: "s1" },
        sessions: [
          {
            id: "s1",
            title: "Approval task",
            activity: { state: "approval", detail: "shell_command", action: "npm install" },
          },
        ],
      },
    },
  });

  assert.match(output, /Approval task/);
  assert.match(output, /\u7b49\u5f85\u6279\u51c6/);
  assert.match(output, /\u7b49\u5f85\u6279\u51c6: npm install/);
});
