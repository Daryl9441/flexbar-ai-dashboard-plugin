"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countInProgress,
  normalizeDotProfile,
  normalizeDotsList,
  parseTimestamp,
} = require("../src/collectors/dotsNormalize");

const TBO_ID = "tbo~test-0001";

// Only the fields the key uses, written by hand from the field names (never a real response).
function profile(overrides = {}) {
  return {
    id: TBO_ID,
    display_name: "Test Dot",
    avatar_url: "https://example.com/a.png",
    status: "active",
    is_paused: false,
    isSafetyFlagged: false,
    safety_flag: null,
    last_check_in_at: "2026-10-08T10:00:00Z",
    messaging_room_id: "room-test-0001",
    messaging_room_preview: {
      message_preview: { latest_item_timestamp: "2026-10-08T11:00:00Z", preview: "made-up preview text" },
      last_read_at: "2026-10-08T11:30:00Z",
      user_room_settings: { notification_setting: "active" },
    },
    ...overrides,
  };
}

test("a profile keeps only what the key shows", () => {
  assert.deepEqual(normalizeDotProfile(profile()), {
    id: TBO_ID,
    name: "Test Dot",
    available: true,
    paused: false,
    safety: false,
    unread: false,
    latestAt: Date.parse("2026-10-08T11:00:00Z"),
    lastCheckInAt: Date.parse("2026-10-08T10:00:00Z"),
  });
  const text = JSON.stringify(normalizeDotProfile(profile()));
  assert.ok(!text.includes("made-up preview text"), "message previews are dropped");
  assert.ok(!text.includes("room-test-0001"));
});

test("availability and pause are separate: a paused dot is still available", () => {
  assert.equal(normalizeDotProfile(profile({ is_paused: true })).available, true);
  assert.equal(normalizeDotProfile(profile({ is_paused: true })).paused, true);
  assert.equal(normalizeDotProfile(profile({ status: "deleting" })).available, false);
  assert.equal(normalizeDotProfile(profile({ status: "creating" })).available, false, "unknown statuses are not available");
  assert.equal(normalizeDotProfile(profile({ status: undefined })).available, false);
});

test("safety comes from isSafetyFlagged or a non-empty safety_flag", () => {
  assert.equal(normalizeDotProfile(profile({ isSafetyFlagged: true })).safety, true);
  assert.equal(normalizeDotProfile(profile({ safety_flag: "paused_for_review" })).safety, true);
  assert.equal(normalizeDotProfile(profile({ safety_flag: { reason: "x" } })).safety, true);
  assert.equal(normalizeDotProfile(profile({ safety_flag: "" })).safety, false);
  assert.equal(normalizeDotProfile(profile({ safety_flag: {} })).safety, false);
  assert.equal(normalizeDotProfile(profile({ isSafetyFlagged: "true" })).safety, false, "only a real boolean counts");
});

test("unread: a newer room item than the last read, unless the room is muted", () => {
  const preview = (latest, lastRead, setting = "active") => ({
    messaging_room_preview: {
      message_preview: { latest_item_timestamp: latest },
      last_read_at: lastRead,
      user_room_settings: { notification_setting: setting },
    },
  });
  assert.equal(normalizeDotProfile(profile(preview("2026-10-08T12:00:00Z", "2026-10-08T11:00:00Z"))).unread, true);
  assert.equal(normalizeDotProfile(profile(preview("2026-10-08T12:00:00Z", null))).unread, true, "never read");
  assert.equal(normalizeDotProfile(profile(preview("2026-10-08T12:00:00Z", "2026-10-08T11:00:00Z", "muted"))).unread, false);
  assert.equal(normalizeDotProfile(profile(preview(null, null))).unread, false);
  assert.equal(normalizeDotProfile(profile(preview("2026-10-08T11:00:00Z", "2026-10-08T11:00:00Z"))).unread, false);
  assert.equal(normalizeDotProfile(profile({ messaging_room_preview: null })).unread, false);
  assert.equal(normalizeDotProfile(profile({ messaging_room_preview: "x" })).unread, false);
});

test("timestamps may be ISO strings, seconds or milliseconds", () => {
  assert.equal(parseTimestamp("2026-10-08T11:00:00Z"), Date.parse("2026-10-08T11:00:00Z"));
  assert.equal(parseTimestamp(1_791_000_000), 1_791_000_000_000);
  assert.equal(parseTimestamp(1_791_000_000_123), 1_791_000_000_123);
  assert.equal(parseTimestamp("1791000000"), 1_791_000_000_000);
  assert.equal(parseTimestamp("yesterday"), null);
  assert.equal(parseTimestamp(0), null);
  assert.equal(parseTimestamp(-5), null);
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp({}), null);
});

test("malformed profiles are dropped and fields of the wrong type are ignored", () => {
  assert.equal(normalizeDotProfile(null), null);
  assert.equal(normalizeDotProfile("x"), null);
  assert.equal(normalizeDotProfile({ display_name: "No id" }), null);
  assert.equal(normalizeDotProfile({ id: "   " }), null);
  assert.deepEqual(normalizeDotProfile({ id: TBO_ID, display_name: 42, is_paused: "yes", last_check_in_at: "never" }), {
    id: TBO_ID,
    name: null,
    available: false,
    paused: false,
    safety: false,
    unread: false,
    latestAt: null,
    lastCheckInAt: null,
  });
});

test("the list keeps well-formed dots and rejects a body without items", () => {
  const list = normalizeDotsList({ items: [profile(), null, { id: "tbo~test-0002", status: "deleting" }], cursor: null });
  assert.deepEqual(list.map((dot) => [dot.id, dot.available]), [[TBO_ID, true], ["tbo~test-0002", false]]);
  assert.deepEqual(normalizeDotsList({ items: [] }), []);
  assert.equal(normalizeDotsList({ detail: "x" }), null);
  assert.equal(normalizeDotsList(null), null);
  assert.equal(normalizeDotsList({ items: Array.from({ length: 40 }, (_, i) => profile({ id: `tbo~t${i}` })) }).length, 25);
});

test("countInProgress counts in_progress activity entries only", () => {
  assert.equal(countInProgress({ data: [{ status: "in_progress" }, { status: "completed", outcome: "failed" }, { status: null }, { status: "in_progress" }], next_cursor: null }), 2);
  assert.equal(countInProgress({ data: [] }), 0);
  assert.equal(countInProgress({ data: [null, "x", { status: "IN_PROGRESS" }] }), 0);
  assert.equal(countInProgress({}), null);
  assert.equal(countInProgress(null), null);
  assert.equal(countInProgress([]), null);
});
