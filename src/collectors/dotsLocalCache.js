"use strict";

// The ChatGPT app's own copy of the primary dot, read when the plugin may not (or cannot) ask the backend:
// $CODEX_HOME/.codex-global-state.json -> "electron-persisted-atom-state" -> "primary-aeon-selection-v1"
// ({ accountId, userId, response: { selection, profile } }), plus "orbit-activity-snapshots-v1" (recent activity per
// dot) to approximate "working". The app writes the file atomically (temp file + rename) and keeps a .bak; atom
// values may be objects or JSON strings. It is only refreshed while the app has focus, so it can be stale: callers
// show its age. That age is the newest Dots timestamp inside the file (the selection's selected_at, the profile's
// updated_at, the Dots sidebar's refreshStartedAtMs), capped at the file's mtime, or null without one: the mtime
// alone says nothing, since the app rewrites the file for hundreds of unrelated atoms. The cached profile carries no
// room preview, so it never reads as unread. Only the fields the key needs are kept; the file is parsed again only
// when it changes.

const nodeFs = require("node:fs");
const path = require("node:path");
const { countInProgress, normalizeDotProfile, parseTimestamp } = require("./dotsNormalize");

const STATE_FILE = ".codex-global-state.json";
const BACKUP_SUFFIX = ".bak";
const ATOM_ROOT = "electron-persisted-atom-state";
const PRIMARY_KEY = "primary-aeon-selection-v1";
const SNAPSHOTS_KEY = "orbit-activity-snapshots-v1";
const SIDEBAR_KEY = "cloud-aeon-sidebar-cache-v1";
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * read({ codexHome, accountId }) -> { dots: [profile] | [], activity: { [id]: inProgress }, updatedAt: ms | null }
 * | null.
 */
function createDotsLocalCache(options = {}) {
  const fs = options.fs || nodeFs;
  let memo = null;

  function load(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      memo = null;
      return null;
    }
    if (memo && memo.file === file && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.extracted;
    const extracted = parseFile(fs, file, stat) || parseBackup(fs, `${file}${BACKUP_SUFFIX}`);
    memo = { file, mtimeMs: stat.mtimeMs, size: stat.size, extracted };
    return extracted;
  }

  return {
    read({ codexHome, accountId = null } = {}) {
      if (!codexHome) return null;
      const extracted = load(path.join(codexHome, STATE_FILE));
      return extracted ? selectForAccount(extracted, accountId) : null;
    },
  };
}

function parseBackup(fs, file) {
  try {
    return parseFile(fs, file, fs.statSync(file));
  } catch {
    return null;
  }
}

function parseFile(fs, file, stat) {
  if (!stat || stat.size > MAX_FILE_BYTES) return null;
  try {
    return extractDotsState(JSON.parse(fs.readFileSync(file, "utf8")), stat.mtimeMs);
  } catch {
    return null;
  }
}

/** The parsed state file -> { accountId, profile | null, snapshots, updatedAt }, or null without a selection. */
function extractDotsState(json, fileTime) {
  const atoms = isObject(json) ? decodeAtom(json[ATOM_ROOT]) : null;
  if (!isObject(atoms)) return null;
  const selection = decodeAtom(atoms[PRIMARY_KEY]);
  if (!isObject(selection) || !isObject(selection.response)) return null;

  const rawProfile = selection.response.profile;
  const profile = rawProfile === null || rawProfile === undefined ? null : normalizeDotProfile(rawProfile);
  if (rawProfile !== null && rawProfile !== undefined && !profile) return null;
  const accountId = stringOrNull(selection.accountId);
  return {
    accountId,
    profile,
    snapshots: activitySnapshots(decodeAtom(atoms[SNAPSHOTS_KEY])),
    updatedAt: dataTime(selection.response, decodeAtom(atoms[SIDEBAR_KEY]), accountId, fileTime),
  };
}

// The newest time the app is known to have had this Dots data, never later than the file holding it.
function dataTime(response, sidebar, accountId, fileTime) {
  const selection = isObject(response.selection) ? response.selection : {};
  const profile = isObject(response.profile) ? response.profile : {};
  const sameAccount = isObject(sidebar) && (!accountId || !stringOrNull(sidebar.accountId) || sidebar.accountId === accountId);
  const times = [
    parseTimestamp(selection.selected_at),
    parseTimestamp(profile.updated_at),
    sameAccount ? parseTimestamp(sidebar.refreshStartedAtMs) : null,
  ].filter((time) => time !== null);
  if (times.length === 0) return null;
  const newest = Math.max(...times);
  return Number.isFinite(fileTime) ? Math.round(Math.min(newest, fileTime)) : newest;
}

function activitySnapshots(value) {
  let entries = [];
  if (Array.isArray(value)) entries = value;
  else if (isObject(value)) entries = Object.values(value);
  return entries
    .filter(isObject)
    .map((entry) => ({
      tboId: stringOrNull(entry.tboId),
      accountId: stringOrNull(entry.accountId),
      inProgress: countInProgress({ data: entry.data }),
    }))
    .filter((entry) => entry.tboId && entry.inProgress !== null);
}

// Another account's cache (the app signed in elsewhere since) is never shown; without a known account it is.
function selectForAccount(extracted, accountId) {
  if (accountId && extracted.accountId && extracted.accountId !== accountId) return null;
  const dots = extracted.profile ? [extracted.profile] : [];
  const activity = {};
  for (const dot of dots) {
    const snapshot = extracted.snapshots.find((entry) =>
      entry.tboId === dot.id && (!accountId || !entry.accountId || entry.accountId === accountId)
    );
    activity[dot.id] = snapshot ? snapshot.inProgress : 0;
  }
  return { dots, activity, updatedAt: extracted.updatedAt };
}

function decodeAtom(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  STATE_FILE,
  createDotsLocalCache,
};
