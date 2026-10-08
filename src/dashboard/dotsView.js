"use strict";

// What the ChatGPT Dots key shows, from the poller's state (pure: no I/O, no clock of its own).
// Priority across the available dots: safety > working > paused > unknown > update > idle; several dots in the leading state
// read "×n". Data that is not a fresh backend answer (the app's cache, an answer from before a failed request, or
// one older than 10 minutes) gets a hollow light and says why: "Offline · Cache 5m". After a failed request the last
// answer stays, unless the app's cache holds data it had after that answer; a cache of unknown age reads "Cache".

const { normalizeLanguage, t } = require("./i18n");

const DOTS_FACE = Object.freeze({
  LOADING: "loading",
  SIGNED_OUT: "signedOut",
  NONE: "none",
  DEGRADED: "degraded",
  SAFETY: "safety",
  UPDATE: "update",
  WORKING: "working",
  PAUSED: "paused",
  IDLE: "idle",
  UNKNOWN: "unknown",
});
const STALE_AFTER_MS = 10 * 60_000;
const SEPARATOR = " · ";
const PRIORITY = Object.freeze([
  { kind: DOTS_FACE.SAFETY, label: "dotsSafety", color: "orange", test: (dot) => dot.safety },
  { kind: DOTS_FACE.WORKING, label: "dotsWorking", color: "blue", test: (dot, activity) => Number(activity[dot.id]) > 0 },
  { kind: DOTS_FACE.PAUSED, label: "dotsPaused", color: "gray", test: (dot) => dot.paused },
  { kind: DOTS_FACE.UNKNOWN, label: "dotsUnknown", color: "gray", test: (dot, activity) => !Number.isFinite(activity[dot.id]) },
  { kind: DOTS_FACE.UPDATE, label: "dotsUpdate", color: "green", test: (dot) => dot.unread },
  { kind: DOTS_FACE.IDLE, label: "dotsIdle", color: "gray", test: () => true },
]);
const REASON_LABELS = Object.freeze({
  authExpired: "dotsAuthExpired",
  authRejected: "dotsAuthExpired",
  rateLimited: "dotsRateLimited",
  blocked: "dotsBlocked",
});

/**
 * Poller state -> { kind, color, hollow, paused, title, detail, count, source: "network" | "cache" | null,
 * updatedAt }. options: { now, language, showName (default true), staleAfterMs }.
 */
function buildDotsFace(state, options = {}) {
  const ctx = {
    now: Number.isFinite(options.now) ? options.now : Date.now(),
    language: normalizeLanguage(options.language),
    showName: options.showName !== false,
    staleAfterMs: Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : STALE_AFTER_MS,
  };
  if (!state) return messageFace(DOTS_FACE.LOADING, t(ctx.language, "dotsLoading"), "", ctx, true);
  if (state.source === "local") return localFace(state.cache, ctx);
  if (state.signedOut) return messageFace(DOTS_FACE.SIGNED_OUT, t(ctx.language, "dotsSignIn"), t(ctx.language, "dotsSignInHint"), ctx, false);

  const network = state.network ? { ...state.network, source: "network", at: state.network.at } : null;
  const cache = state.cache ? { ...state.cache, source: "cache", at: state.cache.updatedAt } : null;
  const error = state.error && (!network || state.error.at >= network.at) ? state.error : null;
  if (error) return failedFace(error, freshest(network, cache), ctx);
  if (network) return networkFace(network, ctx);
  if (cache) return withNotes(summarize(cache, ctx), cache, [nameOf, ageNote(cache, ctx)], ctx);
  return messageFace(DOTS_FACE.LOADING, t(ctx.language, "dotsLoading"), "", ctx, true);
}

function localFace(cache, ctx) {
  if (!cache) {
    return messageFace(DOTS_FACE.DEGRADED, t(ctx.language, "dotsNoCache"), t(ctx.language, "dotsOpenAppHint"), ctx, true);
  }
  const data = { ...cache, source: "cache", at: cache.updatedAt };
  return withNotes(summarize(data, ctx), data, [nameOf, ageNote(data, ctx)], ctx);
}

function failedFace(error, data, ctx) {
  const reason = t(ctx.language, REASON_LABELS[error.category] || "dotsOffline");
  if (!data) {
    const hint = REASON_LABELS[error.category] === "dotsAuthExpired" ? "dotsOpenAppHint" : "dotsRetrying";
    return messageFace(DOTS_FACE.DEGRADED, reason, t(ctx.language, hint), ctx, true);
  }
  return withNotes(summarize(data, ctx), data, [reason, ageNote(data, ctx)], ctx);
}

function networkFace(network, ctx) {
  const face = summarize(network, ctx);
  if (network.noAccess || ctx.now - network.at <= ctx.staleAfterMs) return finish(face, "network", network.at);
  return withNotes(face, network, [nameOf, ageNote(network, ctx)], ctx);
}

// The face of a set of dots, before any note about where the data came from.
function summarize(data, ctx) {
  const { language } = ctx;
  if (data.noAccess) return baseFace(DOTS_FACE.NONE, "gray", t(language, "dotsUnavailable"), t(language, "dotsUnavailableHint"), 0, null);
  const available = (Array.isArray(data.dots) ? data.dots : []).filter((dot) => dot && dot.available);
  if (available.length === 0) return baseFace(DOTS_FACE.NONE, "gray", t(language, "dotsNone"), t(language, "dotsCreate"), 0, null);

  const activity = data.activity && typeof data.activity === "object" ? data.activity : {};
  let entry = PRIORITY[PRIORITY.length - 1];
  let members = available;
  for (const candidate of PRIORITY) {
    const matching = available.filter((dot) => candidate.test(dot, activity));
    if (matching.length > 0) {
      entry = candidate;
      members = matching;
      break;
    }
  }
  const count = members.length;
  const title = count > 1 ? `${t(language, entry.label)} ×${count}` : t(language, entry.label);
  const name = count === 1 ? members[0].name : null;
  return baseFace(entry.kind, entry.color, title, baseDetail(entry.kind, members, available, ctx), count, name);
}

function baseDetail(kind, members, available, ctx) {
  const { language, now } = ctx;
  const single = members.length === 1 ? members[0] : null;
  if (single && ctx.showName && single.name) return single.name;
  if (kind === DOTS_FACE.UPDATE && single && single.latestAt) {
    return t(language, "dotsAgo").replace("{age}", formatAge(now - single.latestAt, language));
  }
  if (kind === DOTS_FACE.IDLE && available.length === 1 && available[0].lastCheckInAt) {
    return t(language, "dotsCheckIn").replace("{age}", formatAge(now - available[0].lastCheckInAt, language));
  }
  return countLabel(available.length, language);
}

function baseFace(kind, color, title, detail, count, name) {
  return { kind, color, hollow: false, paused: kind === DOTS_FACE.PAUSED, title, detail, count, name };
}

// Replaces the detail with notes (the dot name where it is shown, the reason, the data's age): the light goes hollow.
function withNotes(face, data, notes, ctx) {
  const parts = notes.map((note) => (note === nameOf ? nameOf(face, ctx) : note)).filter(Boolean);
  return finish({ ...face, hollow: true, detail: parts.join(SEPARATOR) }, data.source, data.at);
}

function nameOf(face, ctx) {
  return ctx.showName && face.name ? face.name : "";
}

function ageNote(data, ctx) {
  if (!Number.isFinite(data.at)) return t(ctx.language, "dotsCachedUndated");
  const age = formatAge(ctx.now - data.at, ctx.language);
  return t(ctx.language, data.source === "cache" ? "dotsCached" : "dotsAgo").replace("{age}", age);
}

function messageFace(kind, title, detail, ctx, hollow) {
  return finish({ ...baseFace(kind, "gray", title, detail, 0, null), hollow }, null, null);
}

function finish(face, source, updatedAt) {
  const { name: _name, ...rest } = face;
  return { ...rest, source, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null };
}

// The cache's age is a lower bound on when the app had that data, so it replaces an answer only when it is newer.
function freshest(network, cache) {
  if (network && cache) return Number.isFinite(cache.at) && cache.at > network.at ? cache : network;
  return network || cache;
}

function countLabel(count, language) {
  return count === 1 ? t(language, "dotsCountOne") : t(language, "dotsCount").replace("{n}", String(count));
}

/** "<1m", "5m", "2h", "3d" (zh: "5分钟", ...). */
function formatAge(ms, language) {
  const minutes = Math.floor(Math.max(0, Number(ms) || 0) / 60_000);
  if (minutes < 1) return t(language, "dotsAgeNow");
  if (minutes < 60) return t(language, "dotsAgeMinutes").replace("{n}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(language, "dotsAgeHours").replace("{n}", String(hours));
  return t(language, "dotsAgeDays").replace("{n}", String(Math.floor(hours / 24)));
}

/** For the key's settings page: the state, whether it is degraded, the data source and its time. Nothing else. */
function dotsStatusSummary(state, options = {}) {
  const face = buildDotsFace(state, { ...options, language: "en" });
  return { state: face.kind, degraded: face.hollow, source: face.source, updatedAt: face.updatedAt };
}

module.exports = {
  DOTS_FACE,
  STALE_AFTER_MS,
  buildDotsFace,
  dotsStatusSummary,
  formatAge,
};
