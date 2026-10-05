"use strict";

// Reads the Codex desktop app's scheduled tasks ("Automations") from its SQLite store,
// $CODEX_HOME/sqlite/<name>.db (codex-dev.db in current prod builds). The app writes
// the file concurrently in WAL mode; this module only ever opens it read-only. Each
// item carries its latest run (lastRun) when that run started in the last
// RUN_LOOKBACK_MS, otherwise null.
//
// Privacy: the result ends up in logged snapshots, so it never selects or returns
// prompts, working directories, account/user/installation ids, thread titles or inbox
// text, and never includes the database path.

const fs = require("node:fs");
const path = require("node:path");
const { resolveCodexHome } = require("./paths");

const MAX_ROWS = 200;
const MAX_NAME_LENGTH = 200;
const MAX_RRULE_LENGTH = 500;
const MAX_TOKEN_LENGTH = 40;
// Candidate databases are re-discovered at most this often (or when the chosen one disappears).
const RESCAN_INTERVAL_MS = 60_000;
// After a failed read with unchanged files, wait this long before opening the database
// again; a scan in which a table check failed is also repeated after this long.
const FAILURE_RETRY_MS = 10_000;
const BUSY_TIMEOUT_MS = 250;
// Integer timestamps below this are epoch seconds (1e11 ms is March 1973, 1e11 s is year 5138).
const SECONDS_THRESHOLD = 1e11;
// Only runs started this recently are read: automation_runs keeps every run ever made
// and has no index to find the latest ones by, and an older run is not running any more.
const RUN_LOOKBACK_MS = 24 * 60 * 60_000;
// SQLITE_NOTADB: the file is not a database, which only changes when the file does.
const SQLITE_NOTADB = 26;

const AUTOMATION_COLUMNS = ["id", "name", "status", "next_run_at", "last_run_at", "rrule", "kind", "created_at", "updated_at"];
const RUN_COLUMNS = ["automation_id", "status", "created_at", "updated_at"];

// undefined: not loaded yet; null: unavailable in this runtime.
let sqliteModule;
// sqliteDir -> { scannedAt, interval, dbPath, failed }
const discoveryCache = new Map();
// dbPath -> { signature, hasTable }
const tableCheckCache = new Map();
// dbPath -> { signature, result, lastGood, failedAt }
const resultCache = new Map();

function resetCodexAutomationsCache() {
  discoveryCache.clear();
  tableCheckCache.clear();
  resultCache.clear();
}

// node:sqlite is loaded lazily so the plugin keeps working where it is missing. It is
// still experimental in Node 22 and prints an ExperimentalWarning on first load.
function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  let loaded = null;
  try {
    loaded = (typeof process.getBuiltinModule === "function" && process.getBuiltinModule("node:sqlite")) ||
      require("node:sqlite");
  } catch {
    loaded = null;
  }
  sqliteModule = isSqliteModule(loaded) ? loaded : null;
  return sqliteModule;
}

function isSqliteModule(candidate) {
  return Boolean(candidate) && typeof candidate.DatabaseSync === "function";
}

function emptyResult(reason) {
  return { available: false, reason, stale: false, total: 0, items: [] };
}

function collectCodexAutomations(options = {}) {
  const env = options.env || process.env;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  // options.sqlite: a module with DatabaseSync (tests), or null to simulate a runtime without it.
  const sqlite = options.sqlite === undefined ? loadSqlite() : (isSqliteModule(options.sqlite) ? options.sqlite : null);

  let dbPath;
  if (options.dbPath) {
    dbPath = statFile(options.dbPath) ? options.dbPath : null;
  } else {
    const sqliteDir = path.join(options.codexHome || resolveCodexHome(env), "sqlite");
    if (!sqlite) {
      // Without sqlite the tables cannot be checked; still tell "no app data" apart.
      return listDatabaseFiles(sqliteDir).length > 0 ? emptyResult("sqliteUnavailable") : emptyResult("noDatabase");
    }
    const discovered = discoverDatabase(sqliteDir, sqlite, now);
    dbPath = discovered.dbPath;
    // No database found because one could not be checked (locked, being recovered).
    if (!dbPath && discovered.failed) return emptyResult("readFailed");
  }

  if (!dbPath) return emptyResult("noDatabase");
  if (!sqlite) return emptyResult("sqliteUnavailable");

  const signature = databaseSignature(dbPath);
  if (!signature) return emptyResult("noDatabase");

  const cached = resultCache.get(dbPath);
  if (cached && cached.signature === signature) {
    if (!cached.failedAt) return copyResult(cached.result);
    if (now - cached.failedAt < FAILURE_RETRY_MS) return copyResult(cached.result);
  }

  let result;
  try {
    result = readAutomations(sqlite, dbPath, now);
  } catch {
    // Locked, corrupt or unexpected schema. Keep serving the last good items, marked stale.
    const lastGood = cached && cached.lastGood;
    const failed = lastGood
      ? { ...lastGood, available: false, reason: "readFailed", stale: true }
      : emptyResult("readFailed");
    resultCache.set(dbPath, { signature, result: failed, lastGood: lastGood || null, failedAt: now });
    return copyResult(failed);
  }

  resultCache.set(dbPath, { signature, result, lastGood: result, failedAt: 0 });
  return copyResult(result);
}

function copyResult(result) {
  return {
    ...result,
    items: result.items.map((item) => ({ ...item, lastRun: item.lastRun ? { ...item.lastRun } : null })),
  };
}

function statFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

// Changes whenever the app commits: writes land in the -wal file first and reach the
// main file on checkpoint. An empty -wal holds no data and counts as absent: a read-only
// connection (ours included) creates one when it opens a WAL database.
function databaseSignature(dbPath) {
  const db = statFile(dbPath);
  if (!db) return null;
  const wal = walStat(dbPath);
  return `${db.mtimeMs}:${db.size}|${wal ? `${wal.mtimeMs}:${wal.size}` : "-"}`;
}

function walStat(dbPath) {
  const wal = statFile(`${dbPath}-wal`);
  return wal && wal.size > 0 ? wal : null;
}

function modifiedAt(dbPath) {
  const db = statFile(dbPath);
  if (!db) return -Infinity;
  const wal = walStat(dbPath);
  return Math.max(db.mtimeMs, wal ? wal.mtimeMs : -Infinity);
}

function listDatabaseFiles(sqliteDir) {
  let entries;
  try {
    entries = fs.readdirSync(sqliteDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.name.endsWith(".db") && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => path.join(sqliteDir, entry.name))
    .filter((filePath) => statFile(filePath));
}

// { dbPath, failed }: the most recently changed database with an automations table,
// and whether a table check failed in the scan (which is then repeated sooner).
function discoverDatabase(sqliteDir, sqlite, now) {
  const cached = discoveryCache.get(sqliteDir);
  if (cached && now - cached.scannedAt < cached.interval && (!cached.dbPath || statFile(cached.dbPath))) {
    return cached;
  }

  let failed = false;
  const candidates = [];
  for (const filePath of listDatabaseFiles(sqliteDir)) {
    const check = checkAutomationsTable(sqlite, filePath);
    failed = failed || check.failed;
    if (check.hasTable) candidates.push({ filePath, modified: modifiedAt(filePath) });
  }
  candidates.sort((a, b) => b.modified - a.modified || a.filePath.localeCompare(b.filePath));
  const discovered = {
    scannedAt: now,
    interval: failed ? FAILURE_RETRY_MS : RESCAN_INTERVAL_MS,
    dbPath: candidates.length > 0 ? candidates[0].filePath : null,
    failed,
  };
  discoveryCache.set(sqliteDir, discovered);
  return discovered;
}

// { hasTable, failed }. The answer only changes when the file does, so it is cached
// per file signature. A check that fails (the app holds a lock, recovers or removes its
// WAL) is no answer: it is not cached, and the file keeps the answer it last had (none
// for a file never checked), so the chosen database stays chosen and its last good
// items are served as stale until a check or read succeeds again.
function checkAutomationsTable(sqlite, dbPath) {
  const signature = databaseSignature(dbPath);
  const cached = tableCheckCache.get(dbPath);
  if (cached && cached.signature === signature) return { hasTable: cached.hasTable, failed: false };

  let hasTable;
  try {
    hasTable = withDatabase(sqlite, dbPath, (db) => tableNames(db).has("automations"));
  } catch (error) {
    if (!isNotADatabase(error)) return { hasTable: Boolean(cached && cached.hasTable), failed: true };
    hasTable = false;
  }
  tableCheckCache.set(dbPath, { signature, hasTable });
  return { hasTable, failed: false };
}

function isNotADatabase(error) {
  return Boolean(error) && Number.isInteger(error.errcode) && (error.errcode & 0xff) === SQLITE_NOTADB;
}

function withDatabase(sqlite, dbPath, fn) {
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // Already closed or never fully opened.
    }
  }
}

function tableNames(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('automations', 'automation_runs')").all();
  return new Set(rows.map((row) => row.name));
}

function columnNames(db, table) {
  // table is one of our constant names, never user input.
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function quote(identifier) {
  return `"${identifier}"`;
}

// Normalizes a stored timestamp to epoch milliseconds inside SQL, for ordering.
function msExpression(column) {
  const quoted = quote(column);
  return `(CASE WHEN ${quoted} < ${SECONDS_THRESHOLD} THEN ${quoted} * 1000 ELSE ${quoted} END)`;
}

function readAutomations(sqlite, dbPath, now) {
  return withDatabase(sqlite, dbPath, (db) => {
    const tables = tableNames(db);
    if (!tables.has("automations")) throw new Error("automations table missing");
    const columns = columnNames(db, "automations");
    if (!columns.has("id")) throw new Error("automations.id missing");

    const selected = AUTOMATION_COLUMNS.filter((column) => columns.has(column));
    // Ordering only decides which rows survive the cap; items are sorted again below.
    const order = columns.has("next_run_at")
      ? `CASE WHEN "next_run_at" > 0 THEN 0 ELSE 1 END, ${msExpression("next_run_at")}, "id"`
      : `"id"`;
    const rows = db.prepare(
      `SELECT ${selected.map(quote).join(", ")} FROM automations ORDER BY ${order} LIMIT ${MAX_ROWS}`
    ).all();
    const countRow = db.prepare("SELECT COUNT(*) AS total FROM automations").get();
    const lastRuns = tables.has("automation_runs") ? readLastRuns(db, now - RUN_LOOKBACK_MS) : new Map();

    const items = rows
      .map((row) => toItem(row, lastRuns.get(String(row.id)) || null))
      .sort(compareItems);
    return {
      available: true,
      reason: null,
      stale: false,
      total: Math.max(Number(countRow && countRow.total) || 0, items.length),
      items,
    };
  });
}

// Latest run per automation, among the runs started since `since` (epoch ms): the
// filter comes before the ranking, so only recent runs are sorted, and a run counts only
// if it is the latest overall (nothing started after it). Run status values are not
// documented (the current app writes IN_PROGRESS, PENDING_REVIEW, ACCEPTED and
// ARCHIVED), so they are passed through as stored.
function readLastRuns(db, since) {
  const columns = columnNames(db, "automation_runs");
  if (!columns.has("automation_id")) return new Map();

  const selected = RUN_COLUMNS.filter((column) => columns.has(column));
  const recency = ["created_at", "updated_at"].filter((column) => columns.has(column));
  const window = recency.length > 0
    ? `ORDER BY ${recency.map((column) => `${msExpression(column)} DESC`).join(", ")}`
    : "";
  // Without any timestamp column every run is read, as nothing tells the old ones apart.
  const filter = recency.length > 0 ? ` WHERE ${msExpression(recency[0])} >= ?` : "";
  const statement = db.prepare(
    `SELECT ${selected.map(quote).join(", ")} FROM (` +
      `SELECT ${selected.map(quote).join(", ")}, ` +
      `ROW_NUMBER() OVER (PARTITION BY "automation_id" ${window}) AS run_rank FROM automation_runs${filter}` +
    `) WHERE run_rank = 1`
  );
  const rows = filter ? statement.all(since) : statement.all();

  const lastRuns = new Map();
  for (const row of rows) {
    if (row.automation_id === null || row.automation_id === undefined) continue;
    lastRuns.set(String(row.automation_id), {
      status: normalizeToken(row.status),
      createdAt: normalizeTimestamp(row.created_at),
      updatedAt: normalizeTimestamp(row.updated_at),
    });
  }
  return lastRuns;
}

function toItem(row, lastRun) {
  const { status, rawStatus } = normalizeStatus(row.status);
  return {
    id: String(row.id),
    name: normalizeName(row.name),
    status,
    rawStatus,
    nextRunAt: normalizeTimestamp(row.next_run_at),
    lastRunAt: normalizeTimestamp(row.last_run_at),
    rrule: normalizeText(row.rrule, MAX_RRULE_LENGTH),
    kind: normalizeToken(row.kind),
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    lastRun,
  };
}

// Upcoming first (nextRunAt ascending, unscheduled last), then name and id so the order
// is stable between polls.
function compareItems(a, b) {
  if (a.nextRunAt !== b.nextRunAt) {
    if (a.nextRunAt === null) return 1;
    if (b.nextRunAt === null) return -1;
    return a.nextRunAt - b.nextRunAt;
  }
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// Epoch milliseconds, or null. Accepts seconds (below 1e11), numeric strings, BigInt and
// ISO date strings; 0, negative and non-finite values are null.
function normalizeTimestamp(value) {
  let number;
  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "bigint") {
    number = Number(value);
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+(\.\d+)?$/.test(text)) {
      // Date strings already resolve to milliseconds.
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    number = Number(text);
  } else {
    return null;
  }
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number < SECONDS_THRESHOLD ? number * 1000 : number);
}

// 'ACTIVE' (the column default) and 'PAUSED' are the known values; anything else is kept
// lowercased. A missing status (older schema without the column) means the default.
function normalizeStatus(value) {
  const rawStatus = normalizeToken(value);
  if (rawStatus === null) return { status: "active", rawStatus: null };
  return { status: rawStatus.toLowerCase(), rawStatus };
}

function normalizeName(value) {
  return normalizeText(value, MAX_NAME_LENGTH) || "";
}

function normalizeToken(value) {
  return normalizeText(value, MAX_TOKEN_LENGTH);
}

// Single-line, trimmed, capped at maxLength code points; null when empty.
function normalizeText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const codePoints = Array.from(text);
  return codePoints.length > maxLength ? codePoints.slice(0, maxLength).join("").trimEnd() : text;
}

module.exports = {
  FAILURE_RETRY_MS,
  MAX_NAME_LENGTH,
  MAX_ROWS,
  RESCAN_INTERVAL_MS,
  RUN_LOOKBACK_MS,
  collectCodexAutomations,
  compareItems,
  databaseSignature,
  normalizeName,
  normalizeStatus,
  normalizeText,
  normalizeTimestamp,
  resetCodexAutomationsCache,
};
