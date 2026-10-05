"use strict";

// Pinned before any Date use: the next-run labels are local times, and Berlin has DST
// changes (2026-03-29 and 2026-10-25) to test day counting across.
process.env.TZ = "Europe/Berlin";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { collectAiSnapshot, compactSnapshot } = require("../src/collectors/snapshot");
const { collectorOptionsFromConfig } = require("../src/collectors/pathOverrides");
const {
  AUTOMATION_OVERVIEW_LIMIT,
  AUTOMATION_RUN_STALE_MS,
  buildAutomationOverview,
  calendarDaysBetween,
  formatAutomationNextRun,
} = require("../src/dashboard/viewModel");
const { automationOverviewLayout, renderAutomationOverviewKey } = require("../src/dashboard/render");
const { SESSION_KEY_MODE, nextSessionKeyMode } = require("../src/dashboard/sessionKeyMode");
const { formatMonitorSnapshot } = require("../src/prototype/monitorFormat");

// node:sqlite exists from Node.js 22.5 (behind a flag until 22.13) while the package
// supports 20.10+: the snapshot tests that build a database are skipped without it.
const DatabaseSync = loadDatabaseSync();
const needsSqlite = { skip: DatabaseSync ? false : "node:sqlite is not available in this Node.js" };

function loadDatabaseSync() {
  try {
    const sqlite = (typeof process.getBuiltinModule === "function" && process.getBuiltinModule("node:sqlite")) ||
      require("node:sqlite");
    return (sqlite && sqlite.DatabaseSync) || null;
  } catch {
    return null;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Local wall-clock time in the pinned zone; month is 1-based.
const local = (year, month, day, hour, minute = 0, second = 0) => new Date(year, month - 1, day, hour, minute, second).getTime();
// Monday 2026-10-05 13:35 in Berlin.
const NOW = local(2026, 10, 5, 13, 35);

// An item as collectCodexAutomations returns it; all names are made up.
const task = (id, name, overrides = {}) => ({
  id,
  name,
  status: "active",
  rawStatus: "ACTIVE",
  nextRunAt: null,
  lastRunAt: null,
  rrule: null,
  kind: "cron",
  createdAt: NOW - 24 * HOUR,
  updatedAt: NOW - 24 * HOUR,
  lastRun: null,
  ...overrides,
});
const paused = (id, name, overrides = {}) => task(id, name, { status: "paused", rawStatus: "PAUSED", ...overrides });
const snapshotWith = (items, extra = {}) => ({
  automations: { available: true, reason: null, stale: false, total: items.length, items, ...extra },
});
const rows = (overview) => overview.items.map((item) => [item.title, item.status, item.statusColor, item.timeLabel]);

test("the time zone is pinned for this file", () => {
  assert.equal(new Date(NOW).getDay(), 1, "2026-10-05 is a Monday");
  assert.equal(new Date(NOW).getTimezoneOffset(), -120, "Berlin summer time");
});

test("scheduled tasks: due first, then by next run, then unscheduled, then paused and others by last change", () => {
  const snapshot = snapshotWith([
    paused("p-old", "Paused long ago", { updatedAt: NOW - 2 * HOUR }),
    paused("p-new", "Paused recently", { nextRunAt: NOW + HOUR, updatedAt: NOW - HOUR }),
    task("odd", "Waiting on review", { status: "needs_review", rawStatus: "NEEDS_REVIEW", updatedAt: NOW - 30 * MINUTE }),
    task("gone-1", "Deleted digest", { status: "deleted", rawStatus: "DELETED", nextRunAt: NOW + 10 * MINUTE }),
    task("gone-2", "Archived report", { status: "archived", rawStatus: "ARCHIVED", nextRunAt: NOW + 5 * MINUTE }),
    task("never", "Not scheduled yet"),
    task("evening", "Evening wrap-up", { nextRunAt: local(2026, 10, 5, 18, 30) }),
    task("late", "Overdue triage", { nextRunAt: NOW - 5 * MINUTE }),
    task("soon", "Inbox sweep", { nextRunAt: NOW + 25 * MINUTE }),
    task("default", "Release notes draft", { rawStatus: null, nextRunAt: NOW + 2 * HOUR }),
  ]);

  const all = buildAutomationOverview(snapshot, { now: NOW, limit: 20 });
  assert.deepEqual(rows(all), [
    ["Overdue triage", "due", "blue", "Due"],
    ["Inbox sweep", "scheduled", "green", "in 25m"],
    ["Release notes draft", "scheduled", "green", "15:35"],
    ["Evening wrap-up", "scheduled", "green", "18:30"],
    // Active, but the app has set no next run: nothing is scheduled, so not green.
    ["Not scheduled yet", "unscheduled", "gray", "No next run"],
    ["Waiting on review", "other", "gray", "Needs review"],
    ["Paused recently", "paused", "gray", "Paused"],
    ["Paused long ago", "paused", "gray", "Paused"],
  ]);
  assert.equal(all.total, 8, "deleted and archived tasks are not counted");
  assert.deepEqual([all.available, all.reason], [true, null]);
  assert.deepEqual(all.items.map((item) => item.id), ["late", "soon", "default", "evening", "never", "odd", "p-new", "p-old"]);
  const never = all.items.find((item) => item.id === "never");
  assert.equal(never.shortTimeLabel, "—");
  assert.equal(buildAutomationOverview(snapshot, { now: NOW, language: "zh" }).items[4].timeLabel, "无下次运行");

  const limited = buildAutomationOverview(snapshot, { now: NOW });
  assert.equal(AUTOMATION_OVERVIEW_LIMIT, 6);
  assert.deepEqual(limited.items.map((item) => item.title), [
    "Overdue triage", "Inbox sweep", "Release notes draft", "Evening wrap-up", "Not scheduled yet", "Waiting on review",
  ]);
  assert.equal(limited.total, 8, "total counts every listed task, not only the 6 shown");
});

test("scheduled tasks keep a stable order for equal next runs and count rows past the collector cap", () => {
  const at = NOW + 3 * HOUR;
  const snapshot = snapshotWith([
    task("b", "Same time B", { nextRunAt: at }),
    task("a", "Same time A", { nextRunAt: at }),
    task("c", "", { nextRunAt: at + MINUTE }),
  ], { total: 250 });

  const overview = buildAutomationOverview(snapshot, { now: NOW, language: "zh" });
  assert.deepEqual(overview.items.map((item) => item.title), ["Same time B", "Same time A", "未命名"]);
  assert.equal(overview.total, 250);
  assert.equal(buildAutomationOverview(snapshot, { now: NOW }).items[2].title, "Untitled");
});

test("a task exactly at its next run is due; Chinese labels for due, paused and minutes", () => {
  const snapshot = snapshotWith([
    task("now", "Hourly sync", { nextRunAt: NOW }),
    task("soon", "Inbox sweep", { nextRunAt: NOW + 25 * MINUTE }),
    paused("p", "Monthly cleanup"),
  ]);
  assert.deepEqual(rows(buildAutomationOverview(snapshot, { now: NOW, language: "zh-CN" })), [
    ["Hourly sync", "due", "blue", "待运行"],
    ["Inbox sweep", "scheduled", "green", "25分钟后"],
    ["Monthly cleanup", "paused", "gray", "已暂停"],
  ]);
});

test("missing, unavailable and stale automation data", () => {
  assert.deepEqual(buildAutomationOverview({}, { now: NOW }), { available: false, reason: null, total: 0, items: [] });
  assert.deepEqual(buildAutomationOverview(null, { now: NOW }), { available: false, reason: null, total: 0, items: [] });
  assert.deepEqual(
    buildAutomationOverview({ automations: { available: false, reason: "noDatabase", total: 0, items: [] } }, { now: NOW }),
    { available: false, reason: "noDatabase", total: 0, items: [] }
  );

  // A failed read keeps serving the last good items, marked unavailable.
  const stale = buildAutomationOverview({
    automations: { available: false, reason: "readFailed", stale: true, total: 1, items: [task("x", "Inbox sweep", { nextRunAt: NOW + HOUR })] },
  }, { now: NOW });
  assert.equal(stale.available, false);
  assert.deepEqual(rows(stale), [["Inbox sweep", "scheduled", "green", "14:35"]]);
});

test("next-run labels: minutes, today, tomorrow, weekday and date in English and Chinese", () => {
  const label = (at, now = NOW) => [formatAutomationNextRun(at, now, "en"), formatAutomationNextRun(at, now, "zh")];

  assert.deepEqual(label(NOW + 25 * MINUTE), ["in 25m", "25分钟后"]);
  assert.deepEqual(label(NOW + 30_000), ["in 1m", "1分钟后"], "rounded up, never 0");
  assert.deepEqual(label(NOW + 59 * MINUTE + 30_000), ["in 59m", "59分钟后"], "stays under an hour");
  assert.deepEqual(label(NOW + HOUR), ["14:35", "14:35"], "an hour ahead is a clock time");
  assert.deepEqual(label(local(2026, 10, 5, 23, 59)), ["23:59", "23:59"]);
  // Tomorrow, across midnight.
  assert.deepEqual(label(local(2026, 10, 6, 0, 40), local(2026, 10, 5, 23, 30)), ["Tmrw 00:40", "明天 00:40"]);
  assert.deepEqual(label(local(2026, 10, 6, 9, 0)), ["Tmrw 09:00", "明天 09:00"]);
  // Under an hour wins even across midnight.
  assert.deepEqual(label(local(2026, 10, 6, 0, 20), local(2026, 10, 5, 23, 50)), ["in 30m", "30分钟后"]);
  // Within the next 6 calendar days: weekday.
  assert.deepEqual(label(local(2026, 10, 7, 9, 0)), ["Wed 09:00", "周三 09:00"]);
  assert.deepEqual(label(local(2026, 10, 11, 21, 5)), ["Sun 21:05", "周日 21:05"]);
  // 7 days or more: month/day.
  assert.deepEqual(label(local(2026, 10, 12, 9, 0)), ["10/12 09:00", "10/12 09:00"]);
  assert.deepEqual(label(local(2027, 1, 3, 7, 5)), ["01/03 07:05", "01/03 07:05"]);
});

test("next-run labels count calendar days across DST changes", () => {
  const label = (at, now) => formatAutomationNextRun(at, now, "en");

  // Autumn: Saturday 23:30 -> Monday 00:15 is 25h45m (the clocks go back), two calendar days.
  assert.equal(local(2026, 10, 26, 0, 15) - local(2026, 10, 24, 23, 30), 25.75 * HOUR);
  assert.equal(label(local(2026, 10, 26, 0, 15), local(2026, 10, 24, 23, 30)), "Mon 00:15");
  assert.equal(label(local(2026, 10, 25, 23, 0), local(2026, 10, 24, 23, 30)), "Tmrw 23:00");
  // Spring: Saturday 23:30 -> Monday 00:15 is only 23h45m (the clocks go forward), still two days.
  assert.equal(local(2026, 3, 30, 0, 15) - local(2026, 3, 28, 23, 30), 23.75 * HOUR);
  assert.equal(label(local(2026, 3, 30, 0, 15), local(2026, 3, 28, 23, 30)), "Mon 00:15");
  assert.equal(label(local(2026, 3, 29, 23, 0), local(2026, 3, 28, 23, 30)), "Tmrw 23:00");
  // The 7th day out across the change is a date, not the same weekday again.
  assert.equal(label(local(2026, 10, 31, 9, 0), local(2026, 10, 24, 8, 0)), "10/31 09:00");

  assert.equal(calendarDaysBetween(local(2026, 10, 24, 23, 59), local(2026, 10, 25, 0, 1)), 1);
  assert.equal(calendarDaysBetween(local(2026, 10, 24, 0, 0), local(2026, 10, 31, 23, 59)), 7);
  assert.equal(calendarDaysBetween(local(2026, 12, 31, 22, 0), local(2027, 1, 1, 1, 0)), 1);
});

test("other statuses are shown capitalized and whole; the renderer cuts them to the room it has", () => {
  const label = (rawStatus, language) => buildAutomationOverview(
    snapshotWith([task("x", "Inbox sweep", { status: rawStatus.toLowerCase(), rawStatus })]),
    { now: NOW, language }
  ).items[0];
  assert.deepEqual([label("DISABLED").status, label("DISABLED").statusColor, label("DISABLED").timeLabel], ["other", "gray", "Disabled"]);
  assert.equal(label("in-progress").timeLabel, "In progress");
  assert.deepEqual([label("WAITING_FOR_NETWORK").timeLabel, label("WAITING_FOR_NETWORK").shortTimeLabel], ["Waiting for network", "Waiting for network"]);
  assert.equal(label("NEEDS_ATTENTION", "zh").timeLabel, "Needs attention", "the app's own word, not translated");
});

test("a task whose latest run is in progress is running: blue, first, labelled Running with its next run", () => {
  const run = (status, startedAgo, updatedAgo = startedAgo) => ({ status, createdAt: NOW - startedAgo, updatedAt: NOW - updatedAgo });
  const snapshot = snapshotWith([
    task("soon", "Inbox sweep", { nextRunAt: NOW + 25 * MINUTE }),
    task("late", "Overdue triage", { nextRunAt: NOW - 5 * MINUTE }),
    // The app's run statuses: IN_PROGRESS while it runs, then PENDING_REVIEW, ACCEPTED or ARCHIVED.
    task("run-old", "Nightly digest", { nextRunAt: local(2026, 10, 6, 2, 0), lastRun: run("IN_PROGRESS", 40 * MINUTE) }),
    task("run-new", "Release notes draft", { nextRunAt: NOW + 2 * HOUR, lastRun: run("in_progress", 2 * MINUTE) }),
    task("reviewed", "Weekly review", { nextRunAt: NOW + 3 * HOUR, lastRun: run("PENDING_REVIEW", 10 * MINUTE) }),
    // Left IN_PROGRESS by an app that quit mid-run: too old to still be running.
    task("abandoned", "Stale digest", { nextRunAt: NOW + 4 * HOUR, lastRun: run("IN_PROGRESS", AUTOMATION_RUN_STALE_MS + MINUTE) }),
    // Still updated recently, so a long run counts.
    task("long", "Long audit", { nextRunAt: local(2026, 10, 7, 9, 0), lastRun: run("IN_PROGRESS", 3 * HOUR, 5 * MINUTE) }),
    paused("p-run", "Paused while running", { lastRun: run("IN_PROGRESS", MINUTE) }),
  ]);

  const overview = buildAutomationOverview(snapshot, { now: NOW, limit: 20 });
  assert.deepEqual(rows(overview), [
    // Paused: it will not run again on its own, so no next run.
    ["Paused while running", "running", "blue", "Running"],
    ["Release notes draft", "running", "blue", "Running\u2009·\u200915:35"],
    ["Nightly digest", "running", "blue", "Running\u2009·\u2009Tmrw 02:00"],
    ["Long audit", "running", "blue", "Running\u2009·\u2009Wed 09:00"],
    ["Overdue triage", "due", "blue", "Due"],
    ["Inbox sweep", "scheduled", "green", "in 25m"],
    ["Weekly review", "scheduled", "green", "16:35"],
    ["Stale digest", "scheduled", "green", "17:35"],
  ]);
  // Narrower keys fall back to the short next run, then to the state alone.
  const labels = (item) => [item.timeLabel, item.mediumTimeLabel, item.shortTimeLabel];
  assert.deepEqual(labels(overview.items[0]), ["Running", undefined, "Running"]);
  assert.deepEqual(labels(overview.items[1]), ["Running\u2009·\u200915:35", undefined, "Running"]);
  assert.deepEqual(labels(overview.items[2]), ["Running\u2009·\u2009Tmrw 02:00", "Running\u2009·\u2009Tmrw", "Running"]);
  const zh = buildAutomationOverview(snapshot, { now: NOW, language: "zh" }).items;
  assert.equal(zh[0].timeLabel, "运行中");
  assert.deepEqual(labels(zh[2]), ["运行中\u2009·\u2009明天 02:00", "运行中\u2009·\u2009明天", "运行中"]);
  // A run under way while the next run is already due: the run is what is shown.
  const dueRunning = snapshotWith([task("x", "Inbox sweep", { nextRunAt: NOW - MINUTE, lastRun: run("IN_PROGRESS", MINUTE) })]);
  assert.deepEqual(labels(buildAutomationOverview(dueRunning, { now: NOW }).items[0]), ["Running", undefined, "Running"]);
  // A run without any timestamp is trusted.
  const untimed = snapshotWith([task("x", "Inbox sweep", { lastRun: { status: "IN_PROGRESS", createdAt: null, updatedAt: null } })]);
  assert.equal(buildAutomationOverview(untimed, { now: NOW }).items[0].status, "running");
});

test("short time labels drop the clock time from day labels for narrow keys", () => {
  const both = (at, language = "en") => {
    const [item] = buildAutomationOverview(snapshotWith([task("x", "Inbox sweep", { nextRunAt: at })]), { now: NOW, language }).items;
    return [item.timeLabel, item.shortTimeLabel];
  };
  assert.deepEqual(both(NOW + 25 * MINUTE), ["in 25m", "25m"]);
  assert.deepEqual(both(NOW + 25 * MINUTE, "zh"), ["25分钟后", "25分钟"]);
  assert.deepEqual(both(local(2026, 10, 5, 18, 30)), ["18:30", "18:30"]);
  assert.deepEqual(both(local(2026, 10, 6, 9, 0)), ["Tmrw 09:00", "Tmrw"]);
  assert.deepEqual(both(local(2026, 10, 6, 9, 0), "zh"), ["明天 09:00", "明天"]);
  assert.deepEqual(both(local(2026, 10, 8, 9, 0)), ["Thu 09:00", "Thu"]);
  assert.deepEqual(both(local(2026, 10, 12, 9, 0)), ["10/12 09:00", "10/12"]);
  assert.deepEqual(both(NOW - MINUTE), ["Due", "Due"]);
  assert.equal(formatAutomationNextRun(local(2027, 1, 3, 7, 5), NOW, "en", { short: true }), "01/03");
});

test("automation layout fills 1-3 into the left column and 4-6 into the right", () => {
  const wide = automationOverviewLayout(520, 6);
  assert.equal(wide.columns, 2);
  assert.equal(wide.columnWidth, 245);
  assert.deepEqual(wide.slots.map((slot) => [slot.column, slot.x, slot.y, slot.right]), [
    [0, 8, 12, 253], [0, 8, 30, 253], [0, 8, 48, 253],
    [1, 267, 12, 512], [1, 267, 30, 512], [1, 267, 48, 512],
  ]);
  assert.deepEqual([wide.fontSize, wide.timeFontSize], [13, 12]);
  assert.ok(wide.slots[3].x - wide.slots[0].right >= 14, "a clear gap before the right column's dot");

  const four = automationOverviewLayout(520, 4);
  assert.deepEqual(four.slots.map((slot) => [slot.column, slot.y]), [[0, 12], [0, 30], [0, 48], [1, 12]]);

  // Up to 3 tasks: one full-width column, rows centered vertically.
  for (const count of [1, 2, 3]) {
    const layout = automationOverviewLayout(520, count);
    assert.equal(layout.columns, 1);
    assert.deepEqual(layout.slots.map((slot) => [slot.x, slot.right]), Array(count).fill([8, 512]));
  }
  assert.deepEqual(automationOverviewLayout(520, 1).slots.map((slot) => slot.y), [30]);
  assert.deepEqual(automationOverviewLayout(520, 2).slots.map((slot) => slot.y), [21, 39]);
  assert.deepEqual(automationOverviewLayout(520, 3).slots.map((slot) => slot.y), [12, 30, 48]);

  // Never more than 6; a narrow key gets a narrower gap and the smaller fonts.
  assert.equal(automationOverviewLayout(520, 9).visibleCount, 6);
  const narrow = automationOverviewLayout(240, 6);
  assert.deepEqual([narrow.columnGap, narrow.columnWidth, narrow.fontSize, narrow.timeFontSize], [10, 107, 12, 11]);
  assert.deepEqual(narrow.slots.map((slot) => [slot.x, slot.right]).filter((_, index) => index % 3 === 0), [[8, 115], [125, 232]]);
  assert.deepEqual([narrow.capacity, narrow.visibleCount, narrow.hiddenCount], [6, 6, 0], "240px still holds two columns");
  assert.deepEqual(automationOverviewLayout(240, 0).slots, []);
  assert.deepEqual(automationOverviewLayout("240", 5), automationOverviewLayout(240, 5));

  // Too narrow for two 100px columns: one column of 3 rows, the last one "+N" when more
  // tasks are listed (like the session overview).
  const single = automationOverviewLayout(220, 6);
  assert.deepEqual([single.columns, single.capacity, single.visibleCount, single.hiddenCount], [1, 3, 2, 4]);
  assert.deepEqual(single.slots.map((slot) => [slot.x, slot.y, slot.right]), [[8, 12, 212], [8, 30, 212], [8, 48, 212]]);
  assert.deepEqual([single.fontSize, single.timeFontSize], [13, 12]);
  for (const width of [200, 160, 60]) {
    const layout = automationOverviewLayout(width, 4);
    assert.deepEqual([layout.columns, layout.visibleCount, layout.hiddenCount, layout.slots.length], [1, 2, 2, 3], `${width}px`);
  }
  assert.deepEqual([automationOverviewLayout(160, 3).visibleCount, automationOverviewLayout(160, 3).hiddenCount], [3, 0]);
});

test("automation renderer draws dot, title and right-aligned time label per task", () => {
  const fake = createFakeCanvasModule();
  const overview = buildAutomationOverview(snapshotWith([
    task("a", "Morning standup notes", { nextRunAt: local(2026, 10, 6, 9, 0) }),
    task("b", "Overdue triage", { nextRunAt: NOW - MINUTE }),
    task("c", "Inbox sweep", { nextRunAt: NOW + 25 * MINUTE }),
    task("d", "Release checklist", { nextRunAt: local(2026, 10, 8, 9, 0) }),
    paused("e", "Monthly cleanup"),
  ]), { now: NOW });

  const image = renderAutomationOverviewKey(overview, { width: 520, canvasModule: fake });

  assert.equal(image, "data:image/png;base64,fake");
  assert.deepEqual(fake.arcs.map((arc) => [arc.fill, arc.x, arc.y, arc.radius]), [
    ["#38bdf8", 13, 12, 4.5], ["#22c55e", 13, 30, 4.5], ["#22c55e", 13, 48, 4.5],
    ["#22c55e", 272, 12, 4.5], ["#71717a", 272, 30, 4.5],
  ]);
  const labels = fake.textDraws.filter((draw) => draw.align === "right");
  assert.deepEqual(labels.map((draw) => [draw.text, draw.x, draw.color]), [
    ["Due", 253, "#38bdf8"], ["in 25m", 253, "#d4d4d8"], ["Tmrw 09:00", 253, "#d4d4d8"],
    ["Thu 09:00", 512, "#d4d4d8"], ["Paused", 512, "#d4d4d8"],
  ]);
  assert.ok(labels.every((draw) => /^12px /.test(draw.font)));

  const titles = fake.textDraws.filter((draw) => draw.align === "left");
  // Fake font: 8px per character. "Tmrw 09:00" is 80px, so the title gets 253 - 23 - 80 - 6 = 144px.
  assert.deepEqual(titles.map((draw) => [draw.text, draw.x, draw.y]), [
    ["Overdue triage", 23, 16.5], ["Inbox sweep", 23, 34.5], ["Morning standup...", 23, 52.5],
    ["Release checklist", 282, 16.5], ["Monthly cleanup", 282, 34.5],
  ]);
  assert.deepEqual(titles.map((draw) => [draw.font.startsWith("bold 13px "), draw.color]), [
    [true, "#ffffff"], [true, "#ffffff"], [true, "#ffffff"], [true, "#ffffff"], [false, "#d4d4d8"],
  ], "paused titles are regular weight and dimmed");
});

test("on a 240px key the time labels fall back to their short form instead of being cut", () => {
  // Fake font: 8px per character. Each column has 107 - 15 = 92px after the dot; a label
  // is shown in full while the title keeps 45% (41.4px), else short while it keeps 36px.
  const fake = createFakeCanvasModule();
  const overview = buildAutomationOverview(snapshotWith([
    task("a", "Overdue triage", { nextRunAt: NOW - MINUTE }),
    task("b", "Inbox sweep", { nextRunAt: NOW + 25 * MINUTE }),
    task("c", "Evening wrap-up", { nextRunAt: local(2026, 10, 5, 18, 30) }),
    task("d", "Morning standup notes", { nextRunAt: local(2026, 10, 6, 9, 0) }),
    task("e", "Release checklist", { nextRunAt: local(2026, 10, 8, 9, 0) }),
    task("f", "Monthly invoices", { nextRunAt: local(2026, 10, 12, 9, 0) }),
  ]), { now: NOW });

  renderAutomationOverviewKey(overview, { width: 240, canvasModule: fake });

  const labels = fake.textDraws.filter((draw) => draw.align === "right");
  assert.deepEqual(labels.map((draw) => [draw.text, draw.x]), [
    ["Due", 115], ["25m", 115], ["18:30", 115], ["Tmrw", 232], ["Thu", 232], ["10/12", 232],
  ]);
  const titles = fake.textDraws.filter((draw) => draw.align === "left").map((draw) => draw.text);
  // 92 - label - 6: e.g. "10/12" (40px) leaves 46px, 2 characters and "...".
  assert.deepEqual(titles, ["Over...", "Inbo...", "Ev...", "Mor...", "Rele...", "Mo..."]);
});

test("long state names are cut to the title's share; a key below two columns ends with +N", () => {
  const fake = createFakeCanvasModule();
  const overview = buildAutomationOverview(snapshotWith([
    task("a", "Inbox sweep", { nextRunAt: NOW + 25 * MINUTE }),
    task("b", "Review", { status: "needs_attention", rawStatus: "NEEDS_ATTENTION" }),
  ]), { now: NOW });
  renderAutomationOverviewKey(overview, { width: 240, canvasModule: fake });
  // One full-width column: 224 - 15 = 209px, the label may use 209 - 6 - 94.05.
  assert.deepEqual(fake.textDraws.filter((draw) => draw.align === "right").map((draw) => draw.text), ["in 25m", "Needs attention"]);
  const cut = createFakeCanvasModule();
  renderAutomationOverviewKey(overview, { width: 120, canvasModule: cut });
  assert.deepEqual(cut.textDraws.filter((draw) => draw.align === "right").map((draw) => draw.text), ["25m", "Ne..."]);

  const plus = (items, total) => {
    const canvas = createFakeCanvasModule();
    renderAutomationOverviewKey({ available: true, total, items }, { width: 200, canvasModule: canvas });
    return canvas.textDraws.filter((draw) => draw.align === "left").map((draw) => [draw.text, draw.x, draw.y, draw.color]);
  };
  const six = buildAutomationOverview(snapshotWith([
    task("a", "Inbox sweep", { nextRunAt: NOW + 25 * MINUTE }),
    task("b", "Evening wrap-up", { nextRunAt: local(2026, 10, 5, 18, 30) }),
    task("c", "Overdue triage", { nextRunAt: NOW - MINUTE }),
    ...["d", "e", "f"].map((id) => task(id, `Task ${id}`, { nextRunAt: local(2026, 10, 7, 9, 0) })),
  ]), { now: NOW });
  const rowsAt200 = plus(six.items, six.total);
  assert.deepEqual(rowsAt200.map(([text]) => text).slice(0, 2), ["Overdue triage", "Inbox sweep"]);
  assert.deepEqual(rowsAt200[2], ["+4", 23, 52.5, "#a1a1aa"]);
  // "+N" counts every task not shown, also those past the 6 listed, and turns blue when it
  // hides a due or running one.
  assert.equal(plus(six.items, 9)[2][0], "+7");
  const dueLast = [...six.items.slice(1), six.items[0]].map((item, index) => (index === 5 ? { ...item, status: "due", statusColor: "blue" } : item));
  assert.equal(plus(dueLast, 6)[2][3], "#38bdf8");
});

test("with the real key fonts every time label at 240px and 520px is drawn whole", { skip: !["darwin", "win32"].includes(process.platform) && "key fonts are only set up for macOS and Windows" }, () => {
  const run = (startedAgo) => ({ status: "IN_PROGRESS", createdAt: NOW - startedAgo, updatedAt: NOW - startedAgo });
  const sets = {
    formats: [
      task("a", "Summarize overnight CI failures", { nextRunAt: NOW - MINUTE }),
      task("b", "每周依赖安全审计并生成报告", { nextRunAt: NOW + 25 * MINUTE }),
      task("c", "Evening wrap-up", { nextRunAt: local(2026, 10, 5, 18, 30) }),
      task("d", "晨会纪要和今日待办", { nextRunAt: local(2026, 10, 6, 9, 0) }),
      task("e", "Release checklist reminder", { nextRunAt: local(2026, 10, 8, 9, 0) }),
      task("f", "每月清理旧的功能分支", { nextRunAt: local(2026, 10, 17, 23, 59) }),
    ],
    states: [
      task("a", "Nightly digest of the build", { nextRunAt: NOW + 3 * HOUR, lastRun: run(MINUTE) }),
      task("b", "汇总夜间持续集成失败", { nextRunAt: NOW - MINUTE }),
      task("c", "Not scheduled yet"),
      paused("d", "每月清理旧的功能分支"),
      task("e", "Branch cleanup", { nextRunAt: local(2026, 10, 6, 9, 0), lastRun: run(2 * MINUTE) }),
      task("f", "整理两周以上未处理的合并请求", { nextRunAt: local(2026, 10, 9, 9, 0) }),
    ],
  };
  for (const [name, items] of Object.entries(sets)) {
    for (const language of ["en", "zh"]) {
      const overview = buildAutomationOverview(snapshotWith(items), { now: NOW, language });
      for (const width of [240, 520]) {
        const recorder = recordingCanvasModule();
        renderAutomationOverviewKey(overview, { width, language, canvasModule: recorder });
        const labels = recorder.draws.filter((draw) => draw.align === "right").map((draw) => draw.text);
        const where = `${name} ${language} ${width}px`;
        assert.equal(labels.length, 6, where);
        labels.forEach((label, index) => {
          const item = overview.items[index];
          assert.ok([item.timeLabel, item.mediumTimeLabel, item.shortTimeLabel].includes(label), `${where}: "${label}" for "${item.timeLabel}"`);
          // At 520px only a running task's "Running · Tmrw 09:00" may drop its clock time.
          if (width === 520) assert.equal(label, item.mediumTimeLabel && label === item.mediumTimeLabel ? item.mediumTimeLabel : item.timeLabel, where);
        });
        for (const title of recorder.draws.filter((draw) => draw.align === "left").map((draw) => draw.text)) {
          assert.match(title, /^[^.]{2,}/, `${where}: title "${title}" keeps at least 2 characters`);
        }
      }
    }
  }
});

test("a running task's label drops the clock time, then the next run, as the room shrinks", () => {
  const run = { status: "IN_PROGRESS", createdAt: NOW - MINUTE, updatedAt: NOW - MINUTE };
  const running = task("r", "Nightly digest", { nextRunAt: local(2026, 10, 6, 9, 0), lastRun: run });
  const others = ["b", "c", "d", "e", "f"].map((id) => task(id, `Task ${id}`, { nextRunAt: local(2026, 10, 5, 18, 0) }));
  // The fake canvas measures 8px per character; the label is the right-aligned text.
  const drawn = (items, width) => {
    const fake = createFakeCanvasModule();
    renderAutomationOverviewKey(buildAutomationOverview(snapshotWith(items), { now: NOW }), { width, canvasModule: fake });
    return fake.textDraws.find((draw) => draw.align === "right").text;
  };
  assert.equal(drawn([running], 520), "Running\u2009·\u2009Tmrw 09:00", "one full-width column");
  assert.equal(drawn([running, ...others], 520), "Running\u2009·\u2009Tmrw", "two columns");
  assert.equal(drawn([running, ...others], 300), "Running", "two narrow columns");
});

test("automation renderer shows a hint when there is nothing to list", () => {
  const draw = (view, language) => {
    const fake = createFakeCanvasModule();
    renderAutomationOverviewKey(view, { width: 520, language, canvasModule: fake });
    return fake.texts;
  };
  assert.deepEqual(draw({ available: true, items: [] }, "en"), ["No scheduled tasks"]);
  assert.deepEqual(draw({ available: true, items: [] }, "zh"), ["暂无定时任务"]);
  assert.deepEqual(draw({ available: false, reason: "noDatabase", items: [] }, "en"), ["Scheduled tasks unavailable"]);
  assert.deepEqual(draw({ available: false, reason: "readFailed", items: [] }, "zh"), ["无法读取定时任务"]);
  assert.deepEqual(draw(null, "en"), ["No scheduled tasks"]);
});

test("automation renderer produces PNG images for 0, 1, 3 and 6 tasks and for unavailable data", () => {
  const names = [
    "Summarize overnight CI failures and open issues", "每周依赖安全审计",
    "Morning standup notes", "Release checklist reminder", "Triage stale pull requests", "每月清理旧的功能分支",
  ];
  const items = names.map((name, index) => (index === 5
    ? paused(`t${index}`, name)
    : task(`t${index}`, name, { nextRunAt: NOW + (index - 1) * 7 * HOUR })));
  const views = [
    buildAutomationOverview(snapshotWith([]), { now: NOW }),
    buildAutomationOverview(snapshotWith(items.slice(0, 1)), { now: NOW }),
    buildAutomationOverview(snapshotWith(items.slice(0, 3)), { now: NOW, language: "zh" }),
    buildAutomationOverview(snapshotWith(items), { now: NOW }),
    buildAutomationOverview({ automations: { available: false, reason: "sqliteUnavailable", total: 0, items: [] } }, { now: NOW }),
  ];

  for (const width of [520, 240]) {
    for (const view of views) {
      const image = renderAutomationOverviewKey(view, { width });
      assert.match(image, /^data:image\/png;base64,/);
      const png = Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
      assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, 60]);
    }
  }
});

test("AI Session key taps cycle home -> overview -> scheduled tasks -> home", () => {
  assert.equal(nextSessionKeyMode(undefined), SESSION_KEY_MODE.OVERVIEW);
  assert.equal(nextSessionKeyMode(SESSION_KEY_MODE.HOME), SESSION_KEY_MODE.OVERVIEW);
  assert.equal(nextSessionKeyMode(SESSION_KEY_MODE.OVERVIEW), SESSION_KEY_MODE.AUTOMATIONS);
  assert.equal(nextSessionKeyMode(SESSION_KEY_MODE.AUTOMATIONS), SESSION_KEY_MODE.HOME);
  assert.equal(nextSessionKeyMode("something else"), SESSION_KEY_MODE.OVERVIEW);

  let mode;
  const seen = [];
  for (let tap = 0; tap < 6; tap++) {
    mode = nextSessionKeyMode(mode);
    seen.push(mode);
  }
  assert.deepEqual(seen, ["overview", "automations", "home", "overview", "automations", "home"]);
});

// --- snapshot integration ---------------------------------------------------------

const PRIVATE_PROMPT = "Made-up prompt that must never be logged";

function codexHomeWithAutomations(t, rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-automation-snapshot-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "sqlite"));
  const db = new DatabaseSync(path.join(home, "sqlite", "codex-dev.db"));
  db.exec("CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', next_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO automations (id, name, prompt, status, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(row.id, row.name, PRIVATE_PROMPT, row.status || "ACTIVE", row.nextRunAt ?? null, NOW, NOW);
  db.close();
  return home;
}

const offlineCodex = { includeUsage: false, includeQuota: false, skipAppServer: true, skipOAuthQuota: true };

test("the snapshot reads scheduled tasks from the Codex home override; compactSnapshot keeps counts only", needsSqlite, async (t) => {
  const home = codexHomeWithAutomations(t, [
    { id: "a", name: "Made-up nightly digest", nextRunAt: NOW + HOUR },
    { id: "b", name: "Made-up weekly review", status: "PAUSED" },
  ]);
  // The settings page's CODEX_HOME override, as the plugin passes it to the collectors.
  const codex = { ...collectorOptionsFromConfig({ pathOverrides: { CODEX_HOME: home } }, { env: {} }), ...offlineCodex };

  const snapshot = await collectAiSnapshot({ codex });
  assert.equal(snapshot.automations.available, true);
  assert.equal(snapshot.automations.total, 2);
  assert.deepEqual(snapshot.automations.items.map((item) => [item.name, item.status]), [
    ["Made-up nightly digest", "active"],
    ["Made-up weekly review", "paused"],
  ]);

  const compact = compactSnapshot(snapshot);
  assert.deepEqual(compact.automations, { available: true, reason: null, total: 2 });
  const logged = JSON.stringify(compact);
  assert.doesNotMatch(logged, /Made-up nightly digest|Made-up weekly review|Made-up prompt/);
});

test("the recent-projects collection skips scheduled tasks; a collector failure never breaks the snapshot", needsSqlite, async (t) => {
  const home = codexHomeWithAutomations(t, [{ id: "a", name: "Made-up nightly digest", nextRunAt: NOW + HOUR }]);
  const codex = { codexHome: home, env: {}, ...offlineCodex };

  const skipped = await collectAiSnapshot({ codex, automations: false });
  assert.equal("automations" in skipped, false);
  assert.equal("automations" in compactSnapshot(skipped), false);

  const failing = await collectAiSnapshot({ codex, automations: { now: () => { throw new Error("made-up failure"); } } });
  assert.deepEqual(failing.automations, { available: false, reason: "readFailed", stale: false, total: 0, items: [] });
  assert.equal(failing.providers.codex.provider, "codex");

  const missing = await collectAiSnapshot({ codex: { codexHome: path.join(home, "missing"), env: {}, ...offlineCodex } });
  assert.deepEqual(compactSnapshot(missing).automations, { available: false, reason: "noDatabase", total: 0 });
});

test("the prototype monitor prints one scheduled-tasks line", () => {
  const base = { collectedAt: "2026-10-05T11:35:00.000Z", providers: { codex: { sessions: [] } } };
  const output = formatMonitorSnapshot({
    ...base,
    automations: snapshotWith([
      paused("p", "Monthly cleanup"),
      task("s", "Inbox sweep", { nextRunAt: NOW + 25 * MINUTE }),
    ]).automations,
  }, { now: NOW });
  assert.match(output, /定时任务 2 \| 下次 Inbox sweep \| 25分钟后/);
  assert.match(
    formatMonitorSnapshot({ ...base, automations: { available: false, reason: "noDatabase", total: 0, items: [] } }),
    /定时任务 不可用 \(noDatabase\)/
  );
  assert.doesNotMatch(formatMonitorSnapshot(base), /定时任务/);
});

// The real @napi-rs/canvas, recording every fillText.
function recordingCanvasModule() {
  const real = require("@napi-rs/canvas");
  const module = { draws: [] };
  module.createCanvas = (width, height) => {
    const canvas = real.createCanvas(width, height);
    const context = canvas.getContext("2d");
    const fillText = context.fillText.bind(context);
    context.fillText = (text, x, y) => {
      module.draws.push({ text, x, align: context.textAlign, font: context.font });
      fillText(text, x, y);
    };
    return canvas;
  };
  return module;
}

function createFakeCanvasModule() {
  const module = { texts: [], textDraws: [], arcs: [] };
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
      module.textDraws.push({ text, x, y, font: this.font, color: this.fillStyle, align: this.textAlign });
    },
  };
  module.createCanvas = () => ({
    getContext: () => context,
    toDataURL: () => "data:image/png;base64,fake",
  });
  return module;
}
