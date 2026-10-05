"use strict";

const { normalizeLanguage, t } = require("./i18n");

function createDashboardState() {
  const activeSessions = new Set();
  const unreadFinishedSessions = new Set();

  return {
    markViewed(sessionId) {
      unreadFinishedSessions.delete(sessionId);
    },
    noteSession(sessionId, isActive) {
      const wasActive = activeSessions.has(sessionId);
      if (wasActive && !isActive) unreadFinishedSessions.add(sessionId);

      if (isActive) {
        activeSessions.add(sessionId);
        unreadFinishedSessions.delete(sessionId);
      } else {
        activeSessions.delete(sessionId);
      }
    },
    isUnreadFinished(sessionId) {
      return unreadFinishedSessions.has(sessionId);
    },
  };
}

function buildDashboardViewModel(snapshot, state = createDashboardState(), options = {}) {
  const language = normalizeLanguage(options.language);
  const sessionSlots = Number.isFinite(Number(options.sessionSlots)) ? Number(options.sessionSlots) : 1;
  const rankedSessions = rankSessions(snapshot);
  const sessionViews = rankedSessions.slice(0, Math.max(0, sessionSlots)).map((session) => {
    noteSessionActivity(state, session);
    return buildSessionView(session, state, language);
  });

  return {
    sessions: sessionViews,
    totalTokens: buildTotalTokensView(snapshot, language),
    planUsage: buildPlanUsageView(snapshot, language),
    resetTimer: buildResetTimerView(snapshot, language),
  };
}

// A running session (open turn, tool call, thinking...) with no event for this long
// was abandoned, e.g. killed mid tool call; same limit as the collectors'
// CODEX_OPEN_TURN_STALE_MS.
const SESSION_OVERVIEW_RUNNING_STALE_MS = 30 * 60_000;
// A pending approval waits for the user, who may be away from the desk for hours.
const SESSION_OVERVIEW_APPROVAL_STALE_MS = 6 * 60 * 60_000;
// How long a finished session stays listed (longer while it finished unseen).
const SESSION_OVERVIEW_RECENT_MS = 30 * 60_000;
const OVERVIEW_STATUS_ORDER = { approval: 0, running: 1, done: 2 };

// Sessions waiting for approval (up to 6 h old), running ones with an event in the
// last 30 minutes, then finished ones that are recent or finished while watched and
// not yet viewed; each group newest first, so a "+N" on a full key hides the
// finished ones first.
function buildSessionOverview(snapshot, state = createDashboardState(), options = {}) {
  const language = normalizeLanguage(options.language);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const recentMs = Number.isFinite(Number(options.recentMs)) ? Number(options.recentMs) : SESSION_OVERVIEW_RECENT_MS;

  const listed = [];
  for (const session of rankSessions(snapshot)) {
    const status = sessionOverviewStatus(session, state, now, recentMs);
    if (status) listed.push({ session, status, lastActivity: sessionLastActivityValue(session) });
  }
  // Stable, so equal times keep rankSessions' order.
  listed.sort((a, b) => OVERVIEW_STATUS_ORDER[a.status] - OVERVIEW_STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity);

  const items = listed.map(({ session, status }) => {
    const title = titleFromSession(session, language);
    return {
      sessionKey: session.key,
      title,
      latestTitle: session.latestTitle || title,
      status,
      statusColor: overviewStatusColor(status),
    };
  });

  return {
    items,
    runningCount: items.filter((item) => item.status !== "done").length,
    doneCount: items.filter((item) => item.status === "done").length,
  };
}

// "approval", "running" or "done", or null when the session is not listed. Only
// sessions whose state is trusted are noted: an unknown or stale one keeps what was
// noted before (buildDashboardViewModel notes a stale "running" one as active, and
// the two must not fight), and is listed only if it finished unseen.
function sessionOverviewStatus(session, state, now, recentMs) {
  const activity = session.activity;
  const lastActivity = sessionLastActivityValue(session);
  // Without any timestamp the age is unknown and the reported state is trusted.
  const age = lastActivity > 0 ? now - lastActivity : 0;
  const unreadOrSkip = () => (state.isUnreadFinished(session.key) ? "done" : null);

  if (isUnknownActivity(activity)) return unreadOrSkip();

  if (isActiveActivity(activity)) {
    const approval = activity.state === "approval";
    if (age > (approval ? SESSION_OVERVIEW_APPROVAL_STALE_MS : SESSION_OVERVIEW_RUNNING_STALE_MS)) return unreadOrSkip();
    state.noteSession(session.key, true);
    return approval ? "approval" : "running";
  }

  state.noteSession(session.key, false);
  const recent = lastActivity > 0 && age <= recentMs;
  return state.isUnreadFinished(session.key) || recent ? "done" : null;
}

// The collectors report "unknown" for a session they could not inspect this time
// (no readable events); it keeps whatever state was noted for it before, so a
// running session skipped for one refresh does not count as finished.
function noteSessionActivity(state, session) {
  if (isUnknownActivity(session.activity)) return;
  state.noteSession(session.key, isActiveActivity(session.activity));
}

function isUnknownActivity(activity) {
  return Boolean(activity) && activity.state === "unknown";
}

function applyOverviewTitleMode(overview, mode) {
  if (!overview || mode !== "latest") return overview;
  return {
    ...overview,
    items: overview.items.map((item) => ({ ...item, title: item.latestTitle || item.title })),
  };
}

function overviewStatusColor(status) {
  if (status === "approval") return "orange";
  if (status === "running") return "blue";
  return "green";
}

function rankSessions(snapshot) {
  const providers = snapshot && snapshot.providers || {};
  return [
    ...providerSessions("codex", "Codex", providers.codex),
    ...providerSessions("claude", "Claude", providers.claude),
  ].sort((a, b) => {
    const activeDelta = sessionActivityRank(a) - sessionActivityRank(b);
    if (activeDelta !== 0) return activeDelta;
    const timeDelta = sessionLastActivityValue(b) - sessionLastActivityValue(a);
    if (timeDelta !== 0) return timeDelta;
    return a.key.localeCompare(b.key);
  });
}

function sessionActivityRank(session) {
  return isActiveActivity(session && session.activity) ? 0 : 1;
}

function sessionLastActivityValue(session) {
  if (!session) return 0;
  return timestampValue(
    session.lastActivityAt ||
    session.activity && session.activity.lastEventAt ||
    session.updatedAt
  );
}

function providerSessions(providerKey, providerLabel, provider) {
  if (!provider || !Array.isArray(provider.sessions)) return [];

  const activeId = provider.activeSession && provider.activeSession.id;
  return provider.sessions
    .filter((session) => session && !session.archived && !session.internal)
    .map((session) => {
      const isProviderActive = activeId && session.id === activeId;
      return {
        ...session,
        providerKey,
        providerLabel,
        key: `${providerKey}:${session.id || session.title || session.cwd || "unknown"}`,
        activity: session.activity || (isProviderActive ? provider.activity : null) || { state: "idle" },
      };
    });
}

function buildSessionView(session, state, language) {
  const unreadFinished = state.isUnreadFinished(session.key);
  const active = isActiveActivity(session.activity);
  const approval = session.activity && session.activity.state === "approval";
  const status = approval ? "approval" : active ? "running" : unreadFinished ? "finished-unread" : "idle";

  return {
    id: session.id,
    sessionKey: session.key,
    provider: session.providerLabel,
    title: titleFromSession(session, language),
    latestTitle: session.latestTitle || titleFromSession(session, language),
    tokenLabel: formatSessionTokens(session, language),
    status,
    statusColor: statusColor(status),
    activity: formatActivityText(session.activity, { language }),
    updatedAt: session.updatedAt,
  };
}

function applySessionTitleMode(view, mode) {
  if (!view || mode !== "latest") return view;
  return {
    ...view,
    title: view.latestTitle || view.title,
  };
}

function buildTotalTokensView(snapshot, language) {
  const providers = snapshot && snapshot.providers || {};
  const total = Object.values(providers).reduce((sum, provider) => {
    return sum + providerTokenValue(provider);
  }, 0);

  return {
    title: t(language, "tokenUsageTitle"),
    value: total,
    label: total > 0 ? formatNumber(total) : t(language, "unknown"),
    recentLabel: t(language, "recentUsage"),
    recent: buildTokenChartItems(providers),
  };
}

function buildPlanUsageView(snapshot, language) {
  const providers = snapshot && snapshot.providers || {};
  const items = [
    ...quotaItems("Codex", providers.codex && providers.codex.quota, language),
    ...quotaItems("Claude", providers.claude && providers.claude.quota, language),
  ];

  return {
    title: t(language, "planUsageTitle"),
    items,
    label: items.length ? `${Math.round(averageRemaining(items))}%` : t(language, "unknown"),
  };
}

function quotaItems(provider, quota, language) {
  return dedupeQuotaLimits(extractQuotaLimits(quota)).map((limit) => {
    const usedPercent = clampPercent(limit.usedPercent);
    return {
      provider,
      label: quotaWindowLabel(limit.windowSeconds, language),
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetAt: limit.resetAt,
    };
  });
}

function buildResetTimerView(snapshot, language) {
  const providers = snapshot && snapshot.providers || {};
  const items = [
    ...resetTimerItems("Codex", providers.codex && providers.codex.quota, language),
    ...resetTimerItems("Claude", providers.claude && providers.claude.quota, language),
  ];

  return {
    title: t(language, "resetTimerTitle"),
    items,
  };
}

function resetTimerItems(provider, quota, language) {
  return dedupeQuotaLimits(extractQuotaLimits(quota))
    .map((limit) => ({
      provider,
      label: quotaWindowLabel(limit.windowSeconds, language),
      resetAtMs: toEpochMs(limit.resetAt),
      windowSeconds: limit.windowSeconds,
    }))
    .filter((item) => item.resetAtMs !== null);
}

// Names that state their own length (Claude's five_hour / seven_day). Codex's
// "primary" / "secondary" say nothing about it: a plan may have only a weekly window.
function namedQuotaWindowSeconds(label) {
  const text = String(label || "");
  if (/five[_-]?hour|(^|[^0-9a-z])5h($|[^0-9a-z])/i.test(text)) return 5 * 60 * 60;
  if (/seven[_-]?day|week/i.test(text)) return 7 * 24 * 60 * 60;
  return null;
}

// Labels a limit by its actual window length; "Usage" when the source does not say.
function quotaWindowLabel(windowSeconds, language) {
  const seconds = Number(windowSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return t(language, "quotaUsage");
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return t(language, "quotaUsage");
  const days = minutes / (24 * 60);
  if (days === 7) return t(language, "quotaWeekly");
  if (days === 1) return t(language, "quotaDaily");
  if (days >= 28 && days <= 31) return t(language, "quotaMonthly");
  if (Number.isInteger(days)) return t(language, "quotaDays").replace("{n}", String(days));
  if (minutes % 60 === 0) return t(language, "quotaHours").replace("{n}", String(minutes / 60));
  return t(language, "quotaMinutes").replace("{n}", String(minutes));
}

function toEpochMs(resetAt) {
  if (typeof resetAt === "number" && Number.isFinite(resetAt)) {
    // Reset timestamps arrive as Unix seconds (10-digit) or milliseconds (13-digit).
    return resetAt < 1e12 ? Math.round(resetAt * 1000) : Math.round(resetAt);
  }
  if (typeof resetAt === "string" && resetAt.trim()) {
    const parsed = Date.parse(resetAt);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function extractQuotaLimits(quota) {
  if (!quota) return [];
  if (Array.isArray(quota.limits)) {
    return quota.limits
      .map((limit) => ({
        label: limit.label || limit.id || limit.window,
        usedPercent: limit.usedPercent,
        resetAt: limit.resetAt,
        windowSeconds: positiveNumberOrNull(limit.windowSeconds) ?? namedQuotaWindowSeconds(limit.label || limit.id || limit.window),
      }))
      .filter((limit) => limit.usedPercent !== undefined || limit.resetAt);
  }

  const rateLimits = quota.rateLimits || quota.rate_limits;
  if (rateLimits && typeof rateLimits === "object") {
    return Object.entries(rateLimits)
      .map(([key, value]) => {
        if (!value || typeof value !== "object") return null;
        return {
          label: key,
          usedPercent: value.used_percentage ?? value.usedPercent ?? value.utilization,
          resetAt: value.resets_at ?? value.reset_at ?? value.resetAt,
          windowSeconds: namedQuotaWindowSeconds(key),
        };
      })
      .filter(Boolean)
      .filter((limit) => limit.usedPercent !== undefined || limit.resetAt);
  }

  return [];
}

// One item per window length: copies of a window (rateLimits vs rateLimitsByLimitId,
// model-specific limits) collapse and keep the highest usage. A copy without a length
// joins the window of the same name that has one; shortest windows come first.
function dedupeQuotaLimits(limits) {
  const lengthByName = new Map();
  for (const limit of limits) {
    const name = canonicalQuotaLabel(limit.label);
    if (limit.windowSeconds && !lengthByName.has(name)) lengthByName.set(name, limit.windowSeconds);
  }

  const byWindow = new Map();
  for (const limit of limits) {
    const label = canonicalQuotaLabel(limit.label);
    const windowSeconds = limit.windowSeconds || lengthByName.get(label) || null;
    const key = windowSeconds ? `w:${windowSeconds}` : `n:${label}`;
    const existing = byWindow.get(key);
    if (!existing || Number(limit.usedPercent || 0) > Number(existing.usedPercent || 0)) {
      byWindow.set(key, { ...limit, label, windowSeconds });
    }
  }
  return Array.from(byWindow.values()).sort((a, b) => (a.windowSeconds || Infinity) - (b.windowSeconds || Infinity));
}

function canonicalQuotaLabel(label) {
  const text = String(label || "");
  if (/(^|\.|_)primary$/i.test(text) || /five[_-]?hour|5h/i.test(text)) return "primary";
  if (/(^|\.|_)secondary$/i.test(text) || /seven[_-]?day|week|weekly/i.test(text)) return "secondary";
  return text || "limit";
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number > 0 ? number : null;
}

function averageRemaining(items) {
  if (!items.length) return 0;
  return items.reduce((sum, item) => sum + item.remainingPercent, 0) / items.length;
}

function formatActivityText(activity, options = {}) {
  const language = normalizeLanguage(typeof options === "string" ? options : options.language);
  if (!activity || !activity.state) return t(language, "activityCompleted");
  if (activity.detail === "task_complete") return t(language, "activityCompleted");

  if (activity.state === "approval") {
    return withDetail(t(language, "approvalWaiting"), activity.action);
  }

  if (activity.state === "planning") return activity.action || t(language, "activityPlanning");
  if (activity.state === "thinking") return withDetail(t(language, "activityThinking"), activity.action);

  if (activity.state === "tool") {
    return formatToolAction(activity.detail || "tool", activity.action, false, language);
  }

  if (activity.state === "waiting") {
    if (isKnownTool(activity.detail) && activity.action) {
      return formatToolAction(activity.detail, activity.action, true, language);
    }
    return withDetail(t(language, "activityWaiting"), activity.detail);
  }

  if (activity.state === "working" || activity.state === "active") {
    return withDetail(t(language, "activityProcessing"), activity.detail);
  }

  return t(language, "activityCompleted");
}

function formatToolAction(tool, action, completed, language) {
  const detail = action ? `: ${action}` : "";
  if (isMcpTool(tool)) return `${t(language, completed ? "toolMcpDone" : "toolMcpDoing")} ${tool}${detail}`;

  switch (tool) {
    case "shell_command":
    case "Bash":
      return `${t(language, completed ? "toolBashDone" : "toolBashDoing")}${detail}`;
    case "Read":
      return `${t(language, completed ? "toolReadDone" : "toolReadDoing")}${detail}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "apply_patch":
      return `${t(language, completed ? "toolEditDone" : "toolEditDoing")}${detail}`;
    case "Grep":
    case "Glob":
    case "web_search":
    case "web_search_call":
      return `${t(language, completed ? "toolSearchDone" : "toolSearchDoing")}${detail}`;
    default:
      return `${t(language, completed ? "toolGenericDone" : "toolGenericDoing")} ${tool}${detail}`;
  }
}

function withDetail(label, detail) {
  return detail ? `${label}: ${detail}` : label;
}

function isKnownTool(tool) {
  return Boolean(tool) && ![
    "function_call_output",
    "custom_tool_call_output",
    "mcp_tool_call_output",
    "token_count",
  ].includes(tool);
}

function isMcpTool(tool) {
  return typeof tool === "string" && /^mcp(?:_|-|$)/i.test(tool);
}

function isActiveActivity(activity) {
  if (!activity || activity.detail === "task_complete") return false;
  return ["tool", "thinking", "planning", "working", "active", "waiting", "approval"].includes(activity.state);
}

function statusColor(status) {
  if (status === "approval") return "orange";
  if (status === "finished-unread") return "green";
  if (status === "running") return "blue";
  return "gray";
}

function titleFromSession(session, language) {
  return session.title || session.project || session.cwd || session.id || t(language, "untitled");
}

function formatSessionTokens(session, language) {
  const value = sessionTokenValue(session);
  return value === null ? t(language, "unknown") : formatNumber(value);
}

function providerTokenValue(provider) {
  if (!provider) return 0;
  const sessions = Array.isArray(provider.sessions) ? provider.sessions.filter((session) => !session.archived && !session.internal) : [];
  let total = 0;
  let hasSessionUsage = false;

  for (const session of sessions) {
    const value = sessionTokenValue(session);
    if (value !== null) {
      total += value;
      hasSessionUsage = true;
    }
  }
  if (hasSessionUsage) return total;

  const usage = provider.usage || {};
  if (usage.totals) return tokenTotal(usage.totals);
  if (usage.latestTurn) return usage.latestTurn.totalTokens || tokenTotal(usage.latestTurn);
  return 0;
}

function buildTokenChartItems(providers) {
  return Object.values(providers || {}).flatMap((provider) => {
    const events = recentTokenEventsForProvider(provider).slice(-12);
    const values = tokenChartValues(events);
    const max = Math.max(...values, 0);
    if (max <= 0) return [];

    return events.map((event, index) => {
      const value = values[index];
      return {
        timestamp: event.timestamp || null,
        value,
        label: formatWholeCompactNumber(value),
        intensity: Math.max(4, Math.round((value / max) * 100)),
      };
    });
  });
}

function recentTokenEventsForProvider(provider) {
  const usageEvents = provider && provider.usage && provider.usage.recentTokenEvents;
  if (Array.isArray(usageEvents) && usageEvents.length) return usageEvents;

  return (provider && provider.sessions || []).flatMap((session) => {
    const events = session && session.usage && session.usage.recentTokenEvents;
    return Array.isArray(events) ? events : [];
  });
}

function tokenEventValue(event) {
  const total = Number(event && event.totalTokens);
  if (Number.isFinite(total)) return total;
  return tokenTotal(event);
}

function tokenChartValues(events) {
  return events.map((event, index) => {
    const value = tokenEventValue(event);
    if (!event || event.cumulative !== true) return value;

    const previous = index > 0 ? tokenEventValue(events[index - 1]) : null;
    if (Number.isFinite(previous) && value >= previous) return value - previous;
    return value;
  });
}

function sessionTokenValue(session) {
  const usage = session && session.usage || {};
  if (usage.latestTurn) return Number(usage.latestTurn.totalTokens || tokenTotal(usage.latestTurn));
  if (usage.totals) return tokenTotal(usage.totals);
  return null;
}

function tokenTotal(usage) {
  return Object.values(usage || {}).reduce((sum, value) => {
    return sum + (Number.isFinite(Number(value)) ? Number(value) : 0);
  }, 0);
}

function formatNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return String(number);
}

function formatWholeCompactNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1_000_000) return `${Math.round(number / 1_000_000)}M`;
  if (Math.abs(number) >= 1_000) return `${Math.round(number / 1_000)}k`;
  return String(Math.round(number));
}

function timestampValue(value) {
  if (Number.isFinite(Number(value))) {
    const numeric = Number(value);
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

module.exports = {
  SESSION_OVERVIEW_APPROVAL_STALE_MS,
  SESSION_OVERVIEW_RECENT_MS,
  SESSION_OVERVIEW_RUNNING_STALE_MS,
  buildDashboardViewModel,
  buildSessionOverview,
  createDashboardState,
  applyOverviewTitleMode,
  applySessionTitleMode,
  formatActivityText,
  namedQuotaWindowSeconds,
  quotaWindowLabel,
  rankSessions,
};
