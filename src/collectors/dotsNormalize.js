"use strict";

// Turns ChatGPT Dots data (the backend's tbo profiles and activity, or the same profile cached by the ChatGPT app)
// into the few fields the key shows. Everything else, message previews and room ids included, is dropped here.
// Unknown or mistyped fields read as "not set"; nothing in here throws.

const MAX_DOTS = 25;
const SECONDS_THRESHOLD = 1e12;

/**
 * { id, name, available, paused, safety, unread, latestAt, lastCheckInAt } or null without an id. "available" is
 * status === "active" (the app's own test); being paused is a separate flag, since a paused dot may still run
 * delegated tasks.
 */
function normalizeDotProfile(profile) {
  if (!isObject(profile)) return null;
  const id = typeof profile.id === "string" && profile.id.trim() ? profile.id.trim() : null;
  if (!id) return null;

  const room = roomState(profile.messaging_room_preview);
  return {
    id,
    name: typeof profile.display_name === "string" && profile.display_name.trim() ? profile.display_name.trim() : null,
    available: profile.status === "active",
    paused: profile.is_paused === true,
    safety: profile.isSafetyFlagged === true || hasSafetyFlag(profile.safety_flag),
    unread: room.unread,
    latestAt: room.latestAt,
    lastCheckInAt: parseTimestamp(profile.last_check_in_at),
  };
}

/** GET /tbo body -> normalized dots (at most 25), or null when the body has no items list. */
function normalizeDotsList(body) {
  if (!isObject(body) || !Array.isArray(body.items)) return null;
  return body.items.slice(0, MAX_DOTS).map(normalizeDotProfile).filter(Boolean);
}

/** GET /tbo/{id}/activity body (or a cached activity list wrapped as { data }) -> in-progress count, or null. */
function countInProgress(body) {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  return body.data.filter((entry) => isObject(entry) && entry.status === "in_progress").length;
}

// The app's unread rule on the list's room preview: an item newer than the last read (or never read), unless the
// room's notifications are muted.
function roomState(preview) {
  if (!isObject(preview)) return { unread: false, latestAt: null };
  const message = isObject(preview.message_preview) ? preview.message_preview : {};
  const settings = isObject(preview.user_room_settings) ? preview.user_room_settings : {};
  const latestAt = parseTimestamp(message.latest_item_timestamp);
  const lastReadAt = parseTimestamp(preview.last_read_at);
  const muted = settings.notification_setting === "muted";
  const unread = !muted && latestAt !== null && (lastReadAt === null || latestAt > lastReadAt);
  return { unread, latestAt };
}

function hasSafetyFlag(value) {
  if (value === true) return true;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return false;
}

/** ISO string, epoch seconds or epoch milliseconds (number or digit string) -> ms, or null. */
function parseTimestamp(value) {
  let number = null;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) number = Number(value);
  else if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < SECONDS_THRESHOLD ? Math.round(number * 1000) : Math.round(number);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  MAX_DOTS,
  countInProgress,
  normalizeDotProfile,
  normalizeDotsList,
  parseTimestamp,
};
