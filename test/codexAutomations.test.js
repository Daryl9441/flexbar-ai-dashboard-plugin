"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// node:sqlite exists from Node.js 22.5 (behind a flag until 22.13) while the package
// supports 20.10+: tests that build a database are skipped where it cannot be loaded.
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

const {
  FAILURE_RETRY_MS,
  MAX_NAME_LENGTH,
  MAX_ROWS,
  RESCAN_INTERVAL_MS,
  RUN_LOOKBACK_MS,
  collectCodexAutomations,
  normalizeName,
  normalizeStatus,
  normalizeTimestamp,
  resetCodexAutomationsCache,
} = require("../src/collectors/codexAutomations");

// Schema of the current Codex desktop app.
const FULL_SCHEMA = `
CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', next_run_at INTEGER, last_run_at INTEGER, cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT NOT NULL DEFAULT 'FREQ=HOURLY;INTERVAL=24;BYMINUTE=0', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model TEXT, reasoning_effort TEXT, target_type TEXT, project_id TEXT, kind TEXT NOT NULL DEFAULT 'cron', target_thread_id TEXT, execution_environment TEXT, local_environment_config_path TEXT, plugin_template_id TEXT, notification_policy TEXT, account_id TEXT, user_id TEXT, installation_id TEXT, legacy_automation_id TEXT, auto_archive INTEGER NOT NULL DEFAULT 0, next_run_nominal_at INTEGER);
CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, read_at INTEGER, thread_title TEXT, source_cwd TEXT, inbox_title TEXT, inbox_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_user_message TEXT, archived_assistant_message TEXT, archived_reason TEXT);
`;

// An older layout from before later migrations added columns.
const REDUCED_SCHEMA = `
CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, next_run_at INTEGER, last_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

const BASE_MS = 1_791_186_552_844;
const HOUR_MS = 60 * 60 * 1000;
// Made-up private values that must never reach the result.
const PRIVATE_PROMPT = "Summarize yesterday's notes from the example.com team folder";
const PRIVATE_CWD = "/Users/me/projects/example";
const PRIVATE_ACCOUNT = "account-0000-example";
const PRIVATE_THREAD_TITLE = "Made-up thread title for a run";
const PRIVATE_INBOX = "Made-up inbox summary for a run";

test.beforeEach(() => {
  resetCodexAutomationsCache();
});

function makeCodexHome(t, { sqliteDir = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automations-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (sqliteDir) fs.mkdirSync(path.join(home, "sqlite"));
  return home;
}

function dbFile(home, name = "codex-dev.db") {
  return path.join(home, "sqlite", name);
}

function insertRow(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => row[column]));
}

function createDatabase(filePath, { schema = FULL_SCHEMA, automations = [], runs = [] } = {}) {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(schema);
  for (const row of automations) insertRow(db, "automations", row);
  for (const row of runs) insertRow(db, "automation_runs", row);
  db.close();
  return filePath;
}

function automationRow(overrides = {}) {
  return {
    id: "auto-standup",
    name: "Daily standup notes",
    prompt: PRIVATE_PROMPT,
    created_at: BASE_MS,
    updated_at: BASE_MS,
    ...overrides,
  };
}

function fullAutomationRow(overrides = {}) {
  return automationRow({
    status: "ACTIVE",
    next_run_at: BASE_MS + HOUR_MS,
    last_run_at: BASE_MS - HOUR_MS,
    cwds: JSON.stringify([PRIVATE_CWD]),
    rrule: "FREQ=HOURLY;INTERVAL=24;BYMINUTE=0",
    kind: "cron",
    account_id: PRIVATE_ACCOUNT,
    user_id: PRIVATE_ACCOUNT,
    installation_id: PRIVATE_ACCOUNT,
    ...overrides,
  });
}

function runRow(overrides = {}) {
  return {
    thread_id: "thread-1",
    automation_id: "auto-standup",
    status: "ACCEPTED",
    thread_title: PRIVATE_THREAD_TITLE,
    source_cwd: PRIVATE_CWD,
    inbox_title: PRIVATE_INBOX,
    inbox_summary: PRIVATE_INBOX,
    created_at: BASE_MS,
    updated_at: BASE_MS,
    ...overrides,
  };
}

function setMtime(filePath, ms) {
  const date = new Date(ms);
  fs.utimesSync(filePath, date, date);
}

// Wraps node:sqlite to count opens and record every statement the collector prepares.
function countingSqlite() {
  const calls = { attempts: 0, opens: 0, closes: 0, options: [], sql: [], fail: false };
  class CountingDatabase {
    constructor(filePath, options) {
      calls.attempts += 1;
      if (calls.fail) throw new Error("database is locked");
      this.db = new DatabaseSync(filePath, options);
      calls.opens += 1;
      calls.options.push(options);
    }

    prepare(sql) {
      calls.sql.push(sql);
      return this.db.prepare(sql);
    }

    close() {
      calls.closes += 1;
      this.db.close();
    }
  }
  return { sqlite: { DatabaseSync: CountingDatabase }, calls };
}

test("discovers the database that has an automations table and returns its items", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), { automations: [fullAutomationRow()] });
  setMtime(dbFile(home), BASE_MS - 3 * HOUR_MS);

  // Newer files that are not the automations store.
  const other = new DatabaseSync(dbFile(home, "other.db"));
  other.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
  other.close();
  fs.writeFileSync(dbFile(home, "broken.db"), "not a sqlite database", "utf8");
  fs.writeFileSync(dbFile(home, "notes.txt"), "not a database", "utf8");
  fs.mkdirSync(dbFile(home, "folder.db"));

  const result = collectCodexAutomations({ codexHome: home });

  assert.deepEqual(result, {
    available: true,
    reason: null,
    stale: false,
    total: 1,
    items: [{
      id: "auto-standup",
      name: "Daily standup notes",
      status: "active",
      rawStatus: "ACTIVE",
      nextRunAt: BASE_MS + HOUR_MS,
      lastRunAt: BASE_MS - HOUR_MS,
      rrule: "FREQ=HOURLY;INTERVAL=24;BYMINUTE=0",
      kind: "cron",
      createdAt: BASE_MS,
      updatedAt: BASE_MS,
      lastRun: null,
    }],
  });
});

test("resolves CODEX_HOME from env when no codexHome option is given", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), { automations: [fullAutomationRow()] });

  const result = collectCodexAutomations({ env: { CODEX_HOME: home } });

  assert.equal(result.available, true);
  assert.deepEqual(result.items.map((item) => item.name), ["Daily standup notes"]);
});

test("prefers the most recently modified automations database, counting its -wal file", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  const older = createDatabase(dbFile(home, "codex-dev.db"), {
    automations: [fullAutomationRow({ id: "auto-deps", name: "Weekly dependency check" })],
  });
  const newer = createDatabase(dbFile(home, "codex-beta.db"), {
    automations: [fullAutomationRow({ id: "auto-standup", name: "Daily standup notes" })],
  });
  setMtime(older, BASE_MS - 2 * HOUR_MS);
  setMtime(newer, BASE_MS - HOUR_MS);

  assert.deepEqual(collectCodexAutomations({ codexHome: home }).items.map((item) => item.name), ["Daily standup notes"]);

  // The app keeps its connection open, so recent writes sit in the -wal file and the main
  // file's mtime stays old.
  const writer = new DatabaseSync(older);
  t.after(() => writer.close());
  insertRow(writer, "automations", fullAutomationRow({ id: "auto-release", name: "Release notes draft" }));
  assert.ok(fs.existsSync(`${older}-wal`));
  setMtime(older, BASE_MS - 2 * HOUR_MS);
  setMtime(`${older}-wal`, BASE_MS);
  resetCodexAutomationsCache();

  assert.deepEqual(
    collectCodexAutomations({ codexHome: home }).items.map((item) => item.name).sort(),
    ["Release notes draft", "Weekly dependency check"],
  );
});

test("reports noDatabase when there is no automations store", needsSqlite, (t) => {
  const missing = makeCodexHome(t, { sqliteDir: false });
  assert.deepEqual(collectCodexAutomations({ codexHome: missing }), {
    available: false,
    reason: "noDatabase",
    stale: false,
    total: 0,
    items: [],
  });

  const unrelated = makeCodexHome(t);
  const db = new DatabaseSync(dbFile(unrelated, "state.db"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
  db.close();
  assert.equal(collectCodexAutomations({ codexHome: unrelated }).reason, "noDatabase");

  assert.equal(collectCodexAutomations({ dbPath: dbFile(missing, "missing.db") }).reason, "noDatabase");
});

test("normalizeTimestamp returns epoch milliseconds and converts seconds", () => {
  assert.equal(normalizeTimestamp(BASE_MS), BASE_MS);
  assert.equal(normalizeTimestamp(1_791_186_552), 1_791_186_552_000);
  assert.equal(normalizeTimestamp(1_791_186_552.5), 1_791_186_552_500);
  assert.equal(normalizeTimestamp("1791186552844"), BASE_MS);
  assert.equal(normalizeTimestamp(" 1791186552 "), 1_791_186_552_000);
  assert.equal(normalizeTimestamp(BigInt(BASE_MS)), BASE_MS);
  assert.equal(normalizeTimestamp("2026-10-05T08:00:00.000Z"), Date.UTC(2026, 9, 5, 8));
  for (const empty of [null, undefined, 0, -5, Number.NaN, Infinity, "", "soon", {}, true]) {
    assert.equal(normalizeTimestamp(empty), null, `${String(empty)} should be null`);
  }
});

test("timestamps stored in seconds are returned in milliseconds", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), {
    automations: [fullAutomationRow({
      next_run_at: 1_791_190_000,
      last_run_at: 0,
      created_at: 1_791_100_000,
      updated_at: 1_791_100_000_000,
    })],
  });

  const [item] = collectCodexAutomations({ codexHome: home }).items;

  assert.equal(item.nextRunAt, 1_791_190_000_000);
  assert.equal(item.lastRunAt, null);
  assert.equal(item.createdAt, 1_791_100_000_000);
  assert.equal(item.updatedAt, 1_791_100_000_000);
});

test("normalizeStatus maps known statuses and keeps others lowercased", () => {
  assert.deepEqual(normalizeStatus("ACTIVE"), { status: "active", rawStatus: "ACTIVE" });
  assert.deepEqual(normalizeStatus("PAUSED"), { status: "paused", rawStatus: "PAUSED" });
  assert.deepEqual(normalizeStatus(" Archived "), { status: "archived", rawStatus: "Archived" });
  assert.deepEqual(normalizeStatus(null), { status: "active", rawStatus: null });
  assert.deepEqual(normalizeStatus(undefined), { status: "active", rawStatus: null });
  assert.deepEqual(normalizeStatus(""), { status: "active", rawStatus: null });
});

test("items carry normalized statuses in a stable order", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), {
    automations: [
      fullAutomationRow({ id: "a-paused", name: "Weekly dependency check", status: "PAUSED", next_run_at: null }),
      fullAutomationRow({ id: "a-later", name: "Release notes draft", status: "ACTIVE", next_run_at: BASE_MS + 2 * HOUR_MS }),
      fullAutomationRow({ id: "a-tie", name: "Inbox cleanup", status: "Disabled", next_run_at: BASE_MS + 2 * HOUR_MS }),
      fullAutomationRow({ id: "a-soon", name: "Daily standup notes", status: "ACTIVE", next_run_at: BASE_MS + HOUR_MS }),
      fullAutomationRow({ id: "a-none", name: "Archive old branches", status: "ACTIVE", next_run_at: null }),
    ],
  });

  const items = collectCodexAutomations({ codexHome: home }).items;

  assert.deepEqual(items.map((item) => [item.id, item.status, item.rawStatus]), [
    ["a-soon", "active", "ACTIVE"],
    ["a-tie", "disabled", "Disabled"],
    ["a-later", "active", "ACTIVE"],
    ["a-none", "active", "ACTIVE"],
    ["a-paused", "paused", "PAUSED"],
  ]);
});

test("each automation gets its latest run's raw status and timestamps", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), {
    automations: [
      fullAutomationRow({ id: "auto-standup", name: "Daily standup notes" }),
      fullAutomationRow({ id: "auto-deps", name: "Weekly dependency check" }),
    ],
    runs: [
      runRow({ thread_id: "t-1", status: "ACCEPTED", created_at: BASE_MS - 3 * HOUR_MS, updated_at: BASE_MS - 3 * HOUR_MS }),
      // Stored in seconds but still the most recent run.
      runRow({ thread_id: "t-3", status: "in_progress", created_at: Math.floor((BASE_MS - HOUR_MS) / 1000), updated_at: BASE_MS - HOUR_MS + 5 }),
      runRow({ thread_id: "t-2", status: "PENDING_REVIEW", created_at: BASE_MS - 2 * HOUR_MS, updated_at: BASE_MS - 2 * HOUR_MS }),
      runRow({ thread_id: "t-orphan", automation_id: "auto-deleted", status: "ACCEPTED" }),
    ],
  });

  const items = collectCodexAutomations({ codexHome: home, now: () => BASE_MS }).items;
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.deepEqual(byId["auto-standup"].lastRun, {
    status: "in_progress",
    createdAt: Math.floor((BASE_MS - HOUR_MS) / 1000) * 1000,
    updatedAt: BASE_MS - HOUR_MS + 5,
  });
  assert.equal(byId["auto-deps"].lastRun, null);
  assert.equal(items.length, 2);
});

test("only runs started within the lookback are read, so the table's whole history is not ranked", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), {
    automations: [
      fullAutomationRow({ id: "auto-standup", name: "Daily standup notes" }),
      fullAutomationRow({ id: "auto-deps", name: "Weekly dependency check" }),
      fullAutomationRow({ id: "auto-release", name: "Release notes draft" }),
    ],
    runs: [
      // Left IN_PROGRESS long ago and still the latest run: older than the lookback, not read.
      runRow({ thread_id: "t-old", status: "IN_PROGRESS", created_at: BASE_MS - RUN_LOOKBACK_MS - HOUR_MS, updated_at: BASE_MS - HOUR_MS }),
      runRow({ thread_id: "t-deps-old", automation_id: "auto-deps", status: "ARCHIVED", created_at: BASE_MS - 2 * RUN_LOOKBACK_MS, updated_at: BASE_MS - 2 * RUN_LOOKBACK_MS }),
      runRow({ thread_id: "t-deps", automation_id: "auto-deps", status: "PENDING_REVIEW", created_at: BASE_MS - RUN_LOOKBACK_MS + HOUR_MS, updated_at: BASE_MS - RUN_LOOKBACK_MS + HOUR_MS }),
      // Stored in seconds, right at the edge of the lookback.
      runRow({ thread_id: "t-release", automation_id: "auto-release", status: "IN_PROGRESS", created_at: (BASE_MS - RUN_LOOKBACK_MS) / 1000, updated_at: BASE_MS - RUN_LOOKBACK_MS }),
    ],
  });
  const { sqlite, calls } = countingSqlite();

  const items = collectCodexAutomations({ codexHome: home, sqlite, now: () => BASE_MS }).items;
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.equal(byId["auto-standup"].lastRun, null);
  assert.equal(byId["auto-deps"].lastRun.status, "PENDING_REVIEW");
  assert.deepEqual(byId["auto-release"].lastRun, {
    status: "IN_PROGRESS",
    createdAt: BASE_MS - RUN_LOOKBACK_MS,
    updatedAt: BASE_MS - RUN_LOOKBACK_MS,
  });
  const runQuery = calls.sql.find((sql) => sql.includes("FROM automation_runs"));
  assert.match(runQuery, /FROM automation_runs WHERE .+ >= \?\) WHERE run_rank = 1$/, "filters before it ranks");
});

test("tolerates an older schema with fewer columns", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), {
    schema: REDUCED_SCHEMA,
    automations: [automationRow({ next_run_at: BASE_MS + HOUR_MS, last_run_at: null })],
    runs: [{ thread_id: "t-1", automation_id: "auto-standup", status: "ACCEPTED", created_at: BASE_MS }],
  });

  const result = collectCodexAutomations({ codexHome: home, now: () => BASE_MS });

  assert.equal(result.available, true);
  assert.deepEqual(result.items, [{
    id: "auto-standup",
    name: "Daily standup notes",
    status: "active",
    rawStatus: null,
    nextRunAt: BASE_MS + HOUR_MS,
    lastRunAt: null,
    rrule: null,
    kind: null,
    createdAt: BASE_MS,
    updatedAt: BASE_MS,
    lastRun: { status: "ACCEPTED", createdAt: BASE_MS, updatedAt: null },
  }]);
});

test("works without an automation_runs table", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), {
    schema: "CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    automations: [automationRow()],
  });

  const result = collectCodexAutomations({ codexHome: home });

  assert.equal(result.available, true);
  assert.equal(result.items[0].nextRunAt, null);
  assert.equal(result.items[0].lastRun, null);
});

test("reuses the cached result while the files are unchanged and refreshes after a write", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  const filePath = createDatabase(dbFile(home), { automations: [fullAutomationRow()] });
  const { sqlite, calls } = countingSqlite();

  const first = collectCodexAutomations({ codexHome: home, sqlite });
  const opensAfterFirst = calls.opens;
  assert.ok(opensAfterFirst >= 1);
  assert.ok(calls.options.every((options) => options && options.readOnly === true));

  // Callers may mutate what they get back without touching the cache.
  first.items[0].name = "changed by caller";
  first.items.pop();

  const second = collectCodexAutomations({ codexHome: home, sqlite });
  assert.equal(calls.opens, opensAfterFirst);
  assert.deepEqual(second.items.map((item) => item.name), ["Daily standup notes"]);

  // The app writes through its own connection while ours is closed.
  const writer = new DatabaseSync(filePath);
  t.after(() => writer.close());
  insertRow(writer, "automations", fullAutomationRow({
    id: "auto-deps",
    name: "Weekly dependency check",
    next_run_at: BASE_MS + 3 * HOUR_MS,
  }));

  const third = collectCodexAutomations({ codexHome: home, sqlite });
  assert.equal(calls.opens, opensAfterFirst + 1);
  assert.deepEqual(third.items.map((item) => item.name), ["Daily standup notes", "Weekly dependency check"]);
  assert.equal(third.total, 2);
  assert.equal(calls.closes, calls.opens);
});

test("re-scans the sqlite directory at most every interval, or when the database disappears", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  const first = createDatabase(dbFile(home, "codex-dev.db"), {
    automations: [fullAutomationRow({ id: "auto-deps", name: "Weekly dependency check" })],
  });
  setMtime(first, BASE_MS - HOUR_MS);
  let now = BASE_MS;
  const options = { codexHome: home, now: () => now };

  assert.deepEqual(collectCodexAutomations(options).items.map((item) => item.name), ["Weekly dependency check"]);

  createDatabase(dbFile(home, "codex-next.db"), { automations: [fullAutomationRow()] });
  now += 1000;
  assert.deepEqual(collectCodexAutomations(options).items.map((item) => item.name), ["Weekly dependency check"]);

  now += RESCAN_INTERVAL_MS;
  assert.deepEqual(collectCodexAutomations(options).items.map((item) => item.name), ["Daily standup notes"]);

  fs.rmSync(dbFile(home, "codex-next.db"));
  fs.rmSync(`${dbFile(home, "codex-next.db")}-wal`, { force: true });
  fs.rmSync(`${dbFile(home, "codex-next.db")}-shm`, { force: true });
  now += 1000;
  assert.deepEqual(collectCodexAutomations(options).items.map((item) => item.name), ["Weekly dependency check"]);
});

test("reports sqliteUnavailable when node:sqlite cannot be loaded", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  const filePath = createDatabase(dbFile(home), { automations: [fullAutomationRow()] });

  for (const sqlite of [null, {}]) {
    assert.deepEqual(collectCodexAutomations({ codexHome: home, sqlite }), {
      available: false,
      reason: "sqliteUnavailable",
      stale: false,
      total: 0,
      items: [],
    });
    assert.equal(collectCodexAutomations({ dbPath: filePath, sqlite }).reason, "sqliteUnavailable");
  }

  const empty = makeCodexHome(t, { sqliteDir: false });
  assert.equal(collectCodexAutomations({ codexHome: empty, sqlite: null }).reason, "noDatabase");
});

test("read failures never throw and keep serving the last good items as stale", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  const corrupt = dbFile(home, "corrupt.db");
  fs.writeFileSync(corrupt, "not a sqlite database", "utf8");
  assert.deepEqual(collectCodexAutomations({ dbPath: corrupt }), {
    available: false,
    reason: "readFailed",
    stale: false,
    total: 0,
    items: [],
  });

  const unexpected = dbFile(home, "unexpected.db");
  const db = new DatabaseSync(unexpected);
  db.exec("CREATE TABLE automations (name TEXT)");
  db.close();
  assert.equal(collectCodexAutomations({ dbPath: unexpected }).reason, "readFailed");

  const filePath = createDatabase(dbFile(home), { automations: [fullAutomationRow()] });
  const { sqlite, calls } = countingSqlite();
  let now = BASE_MS;
  const options = { dbPath: filePath, sqlite, now: () => now };
  const good = collectCodexAutomations(options);
  assert.equal(good.available, true);

  calls.fail = true;
  setMtime(filePath, BASE_MS + HOUR_MS);
  const stale = collectCodexAutomations(options);
  assert.equal(stale.available, false);
  assert.equal(stale.reason, "readFailed");
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.items, good.items);
  assert.equal(stale.total, good.total);

  // Unchanged files: no new attempt until the retry delay has passed.
  const attempts = calls.attempts;
  now += 1000;
  assert.equal(collectCodexAutomations(options).stale, true);
  assert.equal(calls.attempts, attempts);

  calls.fail = false;
  now += 60_000;
  const recovered = collectCodexAutomations(options);
  assert.equal(recovered.available, true);
  assert.equal(recovered.stale, false);
  assert.equal(calls.closes, calls.opens);
});

test("a table check that fails (database locked) is retried soon, never cached as a missing table", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), { automations: [fullAutomationRow()] });
  const { sqlite, calls } = countingSqlite();
  let now = BASE_MS;
  const options = { codexHome: home, sqlite, now: () => now };

  calls.fail = true;
  assert.deepEqual(collectCodexAutomations(options), {
    available: false,
    reason: "readFailed",
    stale: false,
    total: 0,
    items: [],
  });

  // The lock is gone and the files never change again (the app is idle or quit).
  calls.fail = false;
  now += FAILURE_RETRY_MS;
  const recovered = collectCodexAutomations(options);
  assert.equal(recovered.available, true);
  assert.deepEqual(recovered.items.map((item) => item.name), ["Daily standup notes"]);
  assert.equal(calls.closes, calls.opens);
});

test("a rescan that cannot check the chosen database keeps serving its last good items as stale", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  const filePath = createDatabase(dbFile(home), { automations: [fullAutomationRow()] });
  const { sqlite, calls } = countingSqlite();
  let now = BASE_MS;
  const options = { codexHome: home, sqlite, now: () => now };
  const good = collectCodexAutomations(options);
  assert.equal(good.available, true);

  // The app writes, then holds a lock during the next regular rescan.
  setMtime(filePath, BASE_MS + HOUR_MS);
  calls.fail = true;
  now += RESCAN_INTERVAL_MS;
  const stale = collectCodexAutomations(options);
  assert.equal(stale.reason, "readFailed");
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.items, good.items);

  calls.fail = false;
  now += 1000;
  assert.equal(collectCodexAutomations(options).stale, true, "no new attempt before the retry delay");
  now += FAILURE_RETRY_MS;
  const recovered = collectCodexAutomations(options);
  assert.equal(recovered.available, true);
  assert.equal(recovered.stale, false);
});

test("a file that is not a database is a definite answer, checked again only when it changes", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  const broken = dbFile(home, "broken.db");
  fs.writeFileSync(broken, "not a sqlite database ".repeat(20), "utf8");
  const { sqlite, calls } = countingSqlite();
  let now = BASE_MS;
  const options = { codexHome: home, sqlite, now: () => now };

  assert.equal(collectCodexAutomations(options).reason, "noDatabase");
  const attempts = calls.attempts;
  now += FAILURE_RETRY_MS;
  assert.equal(collectCodexAutomations(options).reason, "noDatabase");
  now += RESCAN_INTERVAL_MS;
  assert.equal(collectCodexAutomations(options).reason, "noDatabase");
  assert.equal(calls.attempts, attempts, "unchanged, so not opened again");
});

test("caps the number of rows and the name length", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  const longName = "Weekly dependency check ".repeat(20);
  const rows = Array.from({ length: MAX_ROWS + 5 }, (_, index) => fullAutomationRow({
    id: `auto-${String(index).padStart(3, "0")}`,
    name: index === 0 ? longName : `Daily standup notes ${index}`,
    next_run_at: BASE_MS + index * 1000,
  }));
  createDatabase(dbFile(home), { automations: rows });

  const result = collectCodexAutomations({ codexHome: home });

  assert.equal(result.total, MAX_ROWS + 5);
  assert.equal(result.items.length, MAX_ROWS);
  assert.equal(result.items[0].id, "auto-000");
  assert.equal(result.items.at(-1).id, `auto-${MAX_ROWS - 1}`);
  assert.ok(Array.from(result.items[0].name).length <= MAX_NAME_LENGTH);
  assert.ok(result.items[0].name.startsWith("Weekly dependency check"));
});

test("normalizeName flattens whitespace and control characters", () => {
  assert.equal(normalizeName("  Daily\nstandup\tnotes  "), "Daily standup notes");
  assert.equal(normalizeName(null), "");
  assert.equal(Array.from(normalizeName("\u{1F4C5}".repeat(MAX_NAME_LENGTH + 10))).length, MAX_NAME_LENGTH);
});

test("never selects or returns prompts, paths, ids or run text", needsSqlite, (t) => {
  const home = makeCodexHome(t);
  createDatabase(dbFile(home), {
    automations: [fullAutomationRow()],
    runs: [runRow()],
  });
  const { sqlite, calls } = countingSqlite();

  const result = collectCodexAutomations({ codexHome: home, sqlite, now: () => BASE_MS });
  const output = JSON.stringify(result);

  assert.equal(result.items[0].lastRun.status, "ACCEPTED");
  for (const secret of [PRIVATE_PROMPT, PRIVATE_CWD, PRIVATE_ACCOUNT, PRIVATE_THREAD_TITLE, PRIVATE_INBOX, home]) {
    assert.equal(output.includes(secret), false, `output leaked ${secret}`);
  }
  const statements = calls.sql.join("\n");
  assert.doesNotMatch(statements, /SELECT\s+\*/i);
  for (const column of ["prompt", "cwds", "account_id", "user_id", "installation_id", "thread_title", "source_cwd", "inbox_", "archived_"]) {
    assert.equal(statements.includes(column), false, `selected ${column}`);
  }
});
