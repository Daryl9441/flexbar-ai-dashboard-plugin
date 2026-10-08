"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDashboardState,
  buildDashboardViewModel,
  formatActivityText,
} = require("../src/dashboard/viewModel");

test("dashboard assigns session keys to the most recently active non-archived sessions", () => {
  const state = createDashboardState();
  const snapshot = {
    providers: {
      codex: {
        sessions: [
          session("codex-old", "Old Codex", "2026-05-13T08:00:00.000Z", "idle", 10),
          session("codex-active", "Active Codex", "2026-05-13T08:05:00.000Z", "tool", 20),
          session("codex-archived", "Archived", "2026-05-13T08:06:00.000Z", "tool", 30, true),
          session("codex-new", "New Codex", "2026-05-13T08:07:00.000Z", "thinking", 40),
        ],
      },
    },
  };

  const model = buildDashboardViewModel(snapshot, state, { language: "zh", sessionSlots: 2 });

  assert.deepEqual(model.sessions.map((item) => item.id), ["codex-new", "codex-active"]);
  assert.equal(model.sessions[0].title, "New Codex");
  assert.equal(model.sessions[1].activity, "\u6b63\u5728\u8fd0\u884c\u547d\u4ee4: rg src");
  assert.equal(model.totalTokens.label, "70");
});

test("dashboard always shows active sessions before newer completed sessions", () => {
  const state = createDashboardState();
  const snapshot = {
    providers: {
      codex: {
        sessions: [
          session("codex-active", "Active Codex", "2026-05-13T08:00:00.000Z", "tool", 20),
          session("codex-done", "Newer Done", "2026-05-13T08:10:00.000Z", "idle", 30),
          session("codex-thinking", "Codex Thinking", "2026-05-13T07:50:00.000Z", "thinking", 40),
        ],
      },
    },
  };

  const model = buildDashboardViewModel(snapshot, state, { sessionSlots: 2 });

  assert.deepEqual(model.sessions.map((item) => item.id), ["codex-active", "codex-thinking"]);
});

test("dashboard keeps newest order within active sessions", () => {
  const state = createDashboardState();
  const snapshot = {
    providers: {
      codex: {
        sessions: [
          session("active-old", "Active Old", "2026-05-13T08:00:00.000Z", "tool", 20),
          session("active-new", "Active New", "2026-05-13T08:10:00.000Z", "thinking", 30),
        ],
      },
    },
  };

  const model = buildDashboardViewModel(snapshot, state, { sessionSlots: 2 });

  assert.deepEqual(model.sessions.map((item) => item.id), ["active-new", "active-old"]);
});

test("dashboard orders sessions by last activity time before indexed update time", () => {
  const state = createDashboardState();
  const snapshot = {
    providers: {
      codex: {
        sessions: [
          {
            ...session("created-newer", "Created Newer", "2026-05-13T09:00:00.000Z", "tool", 20),
            activity: {
              state: "tool",
              detail: "shell_command",
              action: "rg src",
              lastEventAt: "2026-05-13T09:01:00.000Z",
            },
          },
          {
            ...session("last-active", "Last Active", "2026-05-13T08:00:00.000Z", "tool", 30),
            activity: {
              state: "tool",
              detail: "shell_command",
              action: "node --test",
              lastEventAt: "2026-05-13T09:05:00.000Z",
            },
          },
        ],
      },
    },
  };

  const model = buildDashboardViewModel(snapshot, state, { sessionSlots: 2 });

  assert.deepEqual(model.sessions.map((item) => item.id), ["last-active", "created-newer"]);
});

test("dashboard marks approval sessions orange and finished-unread sessions green until viewed", () => {
  const state = createDashboardState();
  const activeSnapshot = {
    providers: {
      codex: {
        sessions: [
          {
            id: "s1",
            title: "Approval task",
            updatedAt: "2026-05-13T08:00:00.000Z",
            activity: { state: "approval", detail: "shell_command", action: "npm install" },
          },
        ],
      },
    },
  };

  let model = buildDashboardViewModel(activeSnapshot, state, { language: "zh", sessionSlots: 1 });
  assert.equal(model.sessions[0].status, "approval");
  assert.equal(model.sessions[0].statusColor, "orange");
  assert.equal(model.sessions[0].activity, "\u7b49\u5f85\u6279\u51c6: npm install");

  const doneSnapshot = {
    providers: {
      codex: {
        sessions: [
          {
            id: "s1",
            title: "Approval task",
            updatedAt: "2026-05-13T08:01:00.000Z",
            activity: { state: "idle", detail: "task_complete" },
          },
        ],
      },
    },
  };

  model = buildDashboardViewModel(doneSnapshot, state, { language: "zh", sessionSlots: 1 });
  assert.equal(model.sessions[0].status, "finished-unread");
  assert.equal(model.sessions[0].statusColor, "green");

  state.markViewed("codex:s1");
  model = buildDashboardViewModel(doneSnapshot, state, { language: "zh", sessionSlots: 1 });
  assert.equal(model.sessions[0].status, "idle");
  assert.equal(model.sessions[0].statusColor, "gray");
});

test("dashboard does not count a running session the collector could not read as finished", () => {
  const state = createDashboardState();
  const snapshotWith = (activity) => ({
    providers: {
      codex: { sessions: [{ id: "s1", title: "Long task", updatedAt: "2026-05-13T08:00:00.000Z", activity }] },
    },
  });
  const statusOf = (activity) => buildDashboardViewModel(snapshotWith(activity), state, { sessionSlots: 1 }).sessions[0].status;

  assert.equal(statusOf({ state: "tool", detail: "shell_command" }), "running");
  // "unknown": no readable events this refresh (e.g. the rollout tail was skipped).
  assert.equal(statusOf({ state: "unknown", detail: "no session events" }), "idle");
  assert.equal(state.isUnreadFinished("codex:s1"), false);
  assert.equal(statusOf({ state: "tool", detail: "shell_command" }), "running");

  // Once it really finishes it is still reported as finished-unread.
  assert.equal(statusOf({ state: "idle", detail: "task_complete" }), "finished-unread");
  assert.equal(statusOf({ state: "unknown", detail: "no session events" }), "finished-unread");
});

test("dashboard plan usage exposes remaining percentages for 5h and weekly windows", () => {
  const model = buildDashboardViewModel({
    providers: {
      codex: {
        sessions: [],
        quota: {
          limits: [
            { label: "primary", usedPercent: 8, resetAt: 1778696068, windowSeconds: 18000 },
            { label: "secondary", usedPercent: 35, resetAt: 1779189630, windowSeconds: 604800 },
          ],
        },
      },
    },
  }, createDashboardState(), { sessionSlots: 0 });

  assert.deepEqual(model.planUsage.items.map((item) => ({
    label: item.label,
    usedPercent: item.usedPercent,
    remainingPercent: item.remainingPercent,
  })), [
    { label: "5h", usedPercent: 8, remainingPercent: 92 },
    { label: "Weekly", usedPercent: 35, remainingPercent: 65 },
  ]);
});

test("dashboard reset timer exposes reset timestamps and window lengths for 5h and weekly", () => {
  const model = buildDashboardViewModel({
    providers: {
      codex: {
        sessions: [],
        quota: {
          limits: [
            { label: "primary", usedPercent: 8, resetAt: 1778696068, windowSeconds: 18000 },
            { label: "secondary", usedPercent: 35, resetAt: 1779189630, windowSeconds: 604800 },
          ],
        },
      },
    },
  }, createDashboardState(), { sessionSlots: 0 });

  assert.deepEqual(model.resetTimer.items, [
    { label: "5h", resetAtMs: 1778696068000, windowSeconds: 18000 },
    { label: "Weekly", resetAtMs: 1779189630000, windowSeconds: 604800 },
  ]);
});

test("dashboard localizes labels and activity text from the requested language", () => {
  const model = buildDashboardViewModel({
    providers: {
      codex: {
        sessions: [
          session("s1", "", "2026-05-13T08:00:00.000Z", "tool", 20),
        ],
      },
    },
  }, createDashboardState(), { language: "en", sessionSlots: 1 });

  assert.equal(model.sessions[0].activity, "Running command: rg src");
  assert.equal(model.totalTokens.title, "Token Usage");
  assert.equal(model.totalTokens.label, "20");
  assert.equal(model.planUsage.title, "Plan Usage");
  assert.equal(formatActivityText({ state: "waiting", detail: "apply_patch", action: "src/plugin.js" }, { language: "en" }), "Just edited: src/plugin.js");

  const zhModel = buildDashboardViewModel({
    providers: {
      codex: {
        sessions: [
          session("s1", "", "2026-05-13T08:00:00.000Z", "tool", 20),
        ],
      },
    },
  }, createDashboardState(), { language: "zh-CN", sessionSlots: 1 });

  assert.equal(zhModel.sessions[0].activity, "\u6b63\u5728\u8fd0\u884c\u547d\u4ee4: rg src");
  assert.equal(zhModel.totalTokens.title, "\u4ee4\u724c\u7528\u91cf");
  assert.equal(zhModel.planUsage.title, "\u5957\u9910\u7528\u91cf");
});

test("dashboard token usage view exposes recent chart bars from provider usage", () => {
  const model = buildDashboardViewModel({
    providers: {
      codex: {
        usage: {
          recentTokenEvents: [
            { timestamp: "2026-05-13T08:00:00.000Z", totalTokens: 100 },
            { timestamp: "2026-05-13T08:01:00.000Z", totalTokens: 500 },
            { timestamp: "2026-05-13T08:02:00.000Z", totalTokens: 250 },
          ],
        },
        sessions: [],
      },
    },
  }, createDashboardState(), { sessionSlots: 0 });

  assert.deepEqual(model.totalTokens.recent.map((item) => ({
    value: item.value,
    intensity: item.intensity,
  })), [
    { value: 100, intensity: 20 },
    { value: 500, intensity: 100 },
    { value: 250, intensity: 50 },
  ]);
  assert.equal(model.totalTokens.recentLabel, "Recent usage");
});

test("dashboard token usage chart converts cumulative events to per-event bars", () => {
  const model = buildDashboardViewModel({
    providers: {
      codex: {
        usage: {
          recentTokenEvents: [
            { timestamp: "2026-05-13T08:00:00.000Z", totalTokens: 100, cumulative: true },
            { timestamp: "2026-05-13T08:01:00.000Z", totalTokens: 350, cumulative: true },
            { timestamp: "2026-05-13T08:02:00.000Z", totalTokens: 500, cumulative: true },
          ],
        },
        sessions: [],
      },
    },
  }, createDashboardState(), { sessionSlots: 0 });

  assert.deepEqual(model.totalTokens.recent.map((item) => ({
    value: item.value,
    label: item.label,
    intensity: item.intensity,
  })), [
    { value: 100, label: "100", intensity: 40 },
    { value: 250, label: "250", intensity: 100 },
    { value: 150, label: "150", intensity: 60 },
  ]);
});

test("dashboard activity formatter differentiates planning, tools, MCP, and completed tool output", () => {
  assert.equal(formatActivityText({ state: "planning", detail: "token_count", action: "planning..." }), "planning...");
  assert.equal(formatActivityText({ state: "tool", detail: "mcp__node_repl__js", action: "inspect" }, { language: "zh" }), "\u6b63\u5728\u4f7f\u7528 MCP mcp__node_repl__js: inspect");
  assert.equal(formatActivityText({ state: "tool", detail: "custom_tool", action: "run" }, { language: "zh" }), "\u6b63\u5728\u4f7f\u7528\u5de5\u5177 custom_tool: run");
  assert.equal(formatActivityText({ state: "waiting", detail: "apply_patch", action: "src/plugin.js" }, { language: "zh" }), "\u521a\u5b8c\u6210\u7f16\u8f91: src/plugin.js");
});

function session(id, title, updatedAt, state, totalTokens, archived = false) {
  return {
    id,
    title,
    archived,
    updatedAt,
    activity: { state, detail: state === "tool" ? "shell_command" : state, action: state === "tool" ? "rg src" : undefined },
    usage: { latestTurn: { totalTokens } },
  };
}

test("plan usage and reset timer name windows by their real length, not by primary/secondary", () => {
  // A plan with only a weekly Codex window, as codex app-server reports it: primary is 7 days, no secondary.
  const { normalizeCodexQuota } = require("../src/collectors/codex");
  const quota = normalizeCodexQuota({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1791590443 },
      secondary: null,
      planType: "pro",
    },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1791590443 }, secondary: null },
    },
  });
  const snapshot = { providers: { codex: { sessions: [], quota } } };

  const en = buildDashboardViewModel(snapshot, createDashboardState(), { sessionSlots: 0 });
  assert.deepEqual(en.planUsage.items.map((item) => [item.label, item.remainingPercent]), [["Weekly", 83]]);
  assert.deepEqual(en.resetTimer.items.map((item) => [item.label, item.windowSeconds]), [["Weekly", 604800]]);

  const zh = buildDashboardViewModel(snapshot, createDashboardState(), { sessionSlots: 0, language: "zh-CN" });
  assert.deepEqual(zh.planUsage.items.map((item) => item.label), ["\u6bcf\u5468"]);
});

test("plan usage stays neutral when a window's length is unknown", () => {
  const model = buildDashboardViewModel({
    providers: {
      codex: { sessions: [], quota: { limits: [{ label: "primary", usedPercent: 40, resetAt: 1778696068 }] } },
    },
  }, createDashboardState(), { sessionSlots: 0, language: "zh" });

  assert.deepEqual(model.planUsage.items.map((item) => item.label), ["\u7528\u91cf"]);
  assert.deepEqual(model.resetTimer.items.map((item) => [item.label, item.windowSeconds]), [["\u7528\u91cf", null]],
    "the countdown is still shown; the ring needs a window length");
});

test("quota window labels cover hours, days, weekly and monthly in both languages", () => {
  const { quotaWindowLabel } = require("../src/dashboard/viewModel");
  const cases = [
    [5 * 3600, "5h", "5\u5c0f\u65f6"],
    [86400, "Daily", "\u6bcf\u65e5"],
    [3 * 86400, "3d", "3\u5929"],
    [7 * 86400, "Weekly", "\u6bcf\u5468"],
    [30 * 86400, "Monthly", "\u6bcf\u6708"],
    [90 * 60, "90m", "90\u5206\u949f"],
    [20, "Usage", "\u7528\u91cf"],
    [null, "Usage", "\u7528\u91cf"],
  ];
  for (const [seconds, en, zh] of cases) {
    assert.equal(quotaWindowLabel(seconds, "en"), en, String(seconds));
    assert.equal(quotaWindowLabel(seconds, "zh"), zh, String(seconds));
  }
});

test("windows of different lengths under the same name are kept apart", () => {
  const model = buildDashboardViewModel({
    providers: {
      codex: {
        sessions: [],
        quota: {
          limits: [
            { label: "primary", usedPercent: 10, resetAt: 1778696068, windowSeconds: 18000 },
            { label: "codex_other.primary", usedPercent: 50, resetAt: 1779189630, windowSeconds: 604800 },
            { label: "primary", usedPercent: 12, resetAt: 1778696068, windowSeconds: 18000 },
          ],
        },
      },
    },
  }, createDashboardState(), { sessionSlots: 0 });

  assert.deepEqual(model.planUsage.items.map((item) => [item.label, item.usedPercent]), [["5h", 12], ["Weekly", 50]]);
});

test("quota windows merge by length: copies collapse, a copy without a length joins its named window", () => {
  const model = buildDashboardViewModel({
    providers: {
      codex: {
        sessions: [],
        quota: {
          limits: [
            { label: "primary", usedPercent: 17, resetAt: 1791590443 },
            { label: "codex.primary", usedPercent: 17, resetAt: 1791590443, windowSeconds: 604800 },
            { label: "codex_other.secondary", usedPercent: 70, resetAt: 1791590443, windowSeconds: 604800 },
            { label: "codex_other.primary", usedPercent: 40, resetAt: 1778696068, windowSeconds: 18000 },
          ],
        },
      },
    },
  }, createDashboardState(), { sessionSlots: 0 });

  assert.deepEqual(model.planUsage.items.map((item) => [item.label, item.usedPercent]), [["5h", 40], ["Weekly", 70]],
    "one item per window length, shortest first, highest usage kept");
});

test("named window lengths only match whole tokens", () => {
  const { namedQuotaWindowSeconds } = require("../src/dashboard/viewModel");
  assert.equal(namedQuotaWindowSeconds("five_hour"), 18000);
  assert.equal(namedQuotaWindowSeconds("5h"), 18000);
  assert.equal(namedQuotaWindowSeconds("account.seven_day"), 604800);
  assert.equal(namedQuotaWindowSeconds("gpt-5high"), null);
  assert.equal(namedQuotaWindowSeconds("primary"), null);
});

test("plan usage normalizes seconds, milliseconds and ISO reset times and preserves unknown", () => {
  const ms = Date.parse("2026-10-10T12:30:00Z");
  for (const [resetAt, expected] of [[ms / 1000, ms], [ms, ms], ["2026-10-10T12:30:00Z", ms], ["bad", null], [null, null], [undefined, null]]) {
    const model = buildDashboardViewModel({ providers: { codex: { sessions: [], quota: { limits: [
      { label: "primary", usedPercent: 35, windowSeconds: 18000, resetAt },
    ] } } } }, createDashboardState(), { sessionSlots: 0 });
    assert.equal(model.planUsage.items[0].resetAtMs, expected);
    assert.equal(model.planUsage.items[0].remainingPercent, 65);
  }
});
