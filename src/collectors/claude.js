"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { summarizeToolAction } = require("./actionSummary");
const {
  pathExists,
  readJsonlFiles,
  readJsonlTail,
  safeMtimeMs,
  walkJsonlFiles,
} = require("./jsonl");
const {
  resolveClaudeBridgePath,
  resolveClaudeProjectRoots,
} = require("./paths");

// Transcript without an open tool call: idle once nothing was written for 30s.
const CLAUDE_ACTIVITY_STALE_MS = 30_000;
// A turn that is still open (tool call without result, or a hook saying the turn
// is running) counts as abandoned after 30 minutes without any event, so a session
// killed mid tool call does not stay "running" forever. Mirrors Codex.
const CLAUDE_OPEN_TURN_STALE_MS = 30 * 60_000;
// A permission prompt the user has not answered yet stays visible for 6 hours.
const CLAUDE_APPROVAL_STALE_MS = 6 * 3600_000;
// Hooks run asynchronously, so a transcript line may be written shortly after the
// hook that it belongs to.
const CLAUDE_HOOK_CLOCK_SLACK_MS = 5_000;
// The bridge file grows forever: read at most its last 4MB on first sight, then
// only what was appended since the previous read.
const CLAUDE_BRIDGE_TAIL_BYTES = 4 * 1024 * 1024;
const CLAUDE_BRIDGE_SESSION_TTL_MS = 24 * 3600_000;
const CLAUDE_BRIDGE_FINGERPRINT_BYTES = 64;
const RECENT_TOKEN_EVENTS_LIMIT = 10;

const CLAUDE_TURN_OPEN_STATES = new Set(["tool", "thinking", "planning", "working", "active", "waiting", "approval"]);
// Notification hook `notification_type` values (Claude Code 2.x).
const CLAUDE_APPROVAL_NOTIFICATIONS = new Set([
  "permission_prompt",
  "worker_permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);
// Notifications that say nothing about whether this session's turn is running.
const CLAUDE_NEUTRAL_NOTIFICATIONS = new Set([
  "auth_success",
  "agent_completed",
  "push_notification",
  "computer_use_enter",
  "computer_use_exit",
  "quota_auto_resume_fired",
  "quota_auto_resume_stale",
  "quota_auto_resume_disabled",
  "model_refusal_fallback",
]);
const CLAUDE_INTERRUPT_PATTERNS = [
  /^\[Request interrupted by user/i,
  /^The user doesn't want to proceed with this tool use/i,
];

function parseClaudeEntry(entry) {
  const message = entry && entry.message && typeof entry.message === "object"
    ? entry.message
    : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const toolUses = content.filter((item) => item && item.type === "tool_use");
  const toolResults = content.filter((item) => item && item.type === "tool_result");

  return {
    timestamp: entry && entry.timestamp ? entry.timestamp : null,
    type: entry && entry.type ? entry.type : null,
    sessionId: entry && (entry.sessionId || entry.session_id) || null,
    cwd: entry && entry.cwd || null,
    messageId: entry && (entry.message_id || message.id) || null,
    requestId: entry && (entry.requestId || entry.request_id) || null,
    model: message.model || entry && entry.model || null,
    sidechain: Boolean(entry && entry.isSidechain),
    interrupt: isClaudeInterruptEntry(entry),
    contentTypes: content.map((item) => item && item.type).filter(Boolean),
    toolUses: toolUses.map((item) => ({
      id: item.id || null,
      name: item.name || null,
      input: item.input || null,
    })),
    toolResults: toolResults.map((item) => ({
      toolUseId: item.tool_use_id || item.toolUseId || null,
      isError: Boolean(item.is_error || item.isError),
    })),
    usage: extractClaudeUsage(entry),
    userText: extractClaudeUserText(entry),
  };
}

// "[Request interrupted by user]" (Esc while Claude streams or runs a tool) and a
// rejected permission prompt end the turn without a Stop hook.
function isClaudeInterruptEntry(entry) {
  if (!entry || entry.type !== "user") return false;
  const content = entry.message && entry.message.content;
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.flatMap((item) => {
    if (!item) return [];
    if (typeof item === "string") return [item];
    if (item.type === "text") return [item.text];
    if (item.type === "tool_result") {
      if (typeof item.content === "string") return [item.content];
      if (Array.isArray(item.content)) return item.content.map((part) => part && part.text);
    }
    return [];
  }) : [];
  return texts.some((text) => {
    return typeof text === "string" && CLAUDE_INTERRUPT_PATTERNS.some((pattern) => pattern.test(text.trim()));
  });
}

function extractClaudeUserText(entry) {
  if (!entry || entry.type !== "user") return null;
  // Injected context, compaction summaries and interrupts are not prompts.
  if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return null;
  if (isClaudeInterruptEntry(entry)) return null;

  const messageContent = entry.message && entry.message.content;
  const directContent = entry.content;
  const content = Array.isArray(messageContent) || typeof messageContent === "string"
    ? messageContent
    : directContent;

  if (typeof content === "string") {
    // Slash commands, their output and task notifications are recorded as tagged
    // plain-text user turns (<command-name>, <local-command-stdout>, ...).
    if (/^\s*<[a-z][\w-]*>/i.test(content)) return null;
    return titleOrNull(content);
  }
  if (!Array.isArray(content)) return null;

  const text = content.map((item) => {
    if (!item) return "";
    if (typeof item === "string") return item;
    if (item.type === "text" && typeof item.text === "string") return item.text;
    return "";
  }).join(" ").trim();

  return titleOrNull(text);
}

function cleanTitle(text) {
  const cleaned = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

function titleOrNull(text) {
  const title = cleanTitle(text);
  if (!title || isIdeContextTitle(title)) return null;
  return title;
}

function isIdeContextTitle(title) {
  return [
    /^The user selected the lines?/i,
    /^The user opened the file/i,
    /^<ide_selection>/i,
    /^<command-name>/i,
  ].some((pattern) => pattern.test(title));
}

function extractClaudeUsage(entry) {
  const usage = entry && entry.message && entry.message.usage || entry && entry.usage;
  if (!usage) return null;

  return {
    inputTokens: numberFrom(usage.input_tokens),
    outputTokens: numberFrom(usage.output_tokens),
    cacheCreationInputTokens: numberFrom(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens),
    cacheReadInputTokens: numberFrom(usage.cache_read_input_tokens ?? usage.cache_read_tokens),
  };
}

function summarizeClaudeUsage(fileEntries) {
  const seen = new Set();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  let usageEvents = 0;
  let latestUsage = null;
  const recentTokenEvents = [];

  for (const { entry } of fileEntries) {
    const parsed = parseClaudeEntry(entry);
    if (!parsed.usage) continue;

    const key = parsed.messageId && parsed.requestId
      ? `${parsed.messageId}:${parsed.requestId}`
      : `${parsed.timestamp}:${parsed.sessionId}:${usageEvents}`;
    if (seen.has(key)) continue;
    seen.add(key);

    usageEvents += 1;
    latestUsage = parsed.usage;
    recentTokenEvents.push({
      timestamp: parsed.timestamp,
      ...parsed.usage,
      totalTokens: tokenTotal(parsed.usage),
    });
    totals.inputTokens += parsed.usage.inputTokens;
    totals.outputTokens += parsed.usage.outputTokens;
    totals.cacheCreationInputTokens += parsed.usage.cacheCreationInputTokens;
    totals.cacheReadInputTokens += parsed.usage.cacheReadInputTokens;
  }

  return {
    totals,
    latestTurn: latestUsage,
    observedTokenEvents: usageEvents,
    recentTokenEvents: recentTokenEvents.slice(-RECENT_TOKEN_EVENTS_LIMIT),
  };
}

function tokenTotal(usage) {
  return Object.values(usage || {}).reduce((sum, value) => {
    return sum + (Number.isFinite(Number(value)) ? Number(value) : 0);
  }, 0);
}

function summarizeClaudeUsageForSession(entries) {
  return summarizeClaudeUsage(entries.map((entry) => ({ filePath: "", entry })));
}

function inferClaudeActivity(events, bridgeSnapshot, now = Date.now()) {
  if (bridgeSnapshot && bridgeSnapshot.activity) {
    return bridgeSnapshot.activity;
  }

  return inferClaudeTranscriptActivity(claudeTranscriptFacts(events.map(parseClaudeEntry)), now);
}

// What the transcript of one session says, from its parsed entries in any order.
// Subagent (sidechain) entries only prove the session is still busy: titles, open
// tool calls and interrupts come from the main chain.
function claudeTranscriptFacts(parsedEvents) {
  const parsed = parsedEvents
    .filter((event) => event && Number.isFinite(Date.parse(event.timestamp || "")))
    .map((event, index) => ({ event, index, at: Date.parse(event.timestamp) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ event }) => event);
  const main = parsed.filter((event) => !event.sidechain);
  const latest = parsed.at(-1) || null;
  const latestMain = main.at(-1) || null;
  const latestMessage = [...main].reverse().find((event) => event.type === "user" || event.type === "assistant") || null;
  const latestInterrupt = [...main].reverse().find((event) => event.interrupt) || null;
  const latestSidechain = [...parsed].reverse().find((event) => event.sidechain) || null;

  return {
    latest,
    latestMain,
    latestMessage,
    latestAt: latest ? Date.parse(latest.timestamp) : null,
    latestMessageAt: latestMessage ? Date.parse(latestMessage.timestamp) : null,
    latestSidechainAt: latestSidechain ? Date.parse(latestSidechain.timestamp) : null,
    interruptAt: latestInterrupt ? Date.parse(latestInterrupt.timestamp) : null,
    openTool: findOpenClaudeTool(main),
  };
}

function inferClaudeTranscriptActivity(facts, now = Date.now()) {
  const latest = facts.latestMain || facts.latest;
  if (!latest) {
    return {
      state: "unknown",
      detail: "no session events",
      confidence: "low",
      source: "claude_jsonl",
      lastEventAt: null,
      staleMs: null,
    };
  }

  const lastEventAt = new Date(facts.latestAt).toISOString();
  const staleMs = now - facts.latestAt;
  const base = { source: "claude_jsonl", lastEventAt, staleMs };

  if (facts.latestMessage && facts.latestMessage.interrupt) {
    return { state: "idle", detail: "interrupted", confidence: "medium", ...base };
  }

  // A tool call without its result keeps the turn running however long the tool
  // takes (a long build writes nothing to the transcript), up to the open-turn bound.
  const openTool = facts.openTool;
  if (openTool && staleMs <= CLAUDE_OPEN_TURN_STALE_MS) {
    return {
      state: "tool",
      detail: openTool.name || "tool_use",
      action: summarizeToolAction(openTool.name || "tool_use", openTool.input),
      confidence: "medium",
      ...base,
    };
  }

  if (staleMs > CLAUDE_ACTIVITY_STALE_MS) {
    return { state: "idle", detail: "no recent Claude event", confidence: "medium", ...base };
  }

  // The main turn is over but background subagents are still writing.
  if (facts.latest && facts.latest.sidechain) {
    return { state: "working", detail: "subagent", confidence: "low", ...base };
  }

  if (latest.type === "last-prompt") {
    return { state: "working", detail: "prompt submitted", confidence: "medium", ...base };
  }

  if (latest.toolResults.length > 0 || latest.type === "assistant") {
    return {
      state: "waiting",
      detail: latest.toolResults.length > 0 ? "tool_result" : "assistant_message",
      confidence: "low",
      ...base,
    };
  }

  return { state: "active", detail: latest.type, confidence: "low", ...base };
}

// Hooks are authoritative for a session that has them, except that they cannot see
// an interrupt (no Stop hook fires), a session killed mid turn, or turns that run
// without the bridge hooks; the transcript settles those.
function combineClaudeActivity(hookActivity, facts, now = Date.now()) {
  const transcriptActivity = inferClaudeTranscriptActivity(facts, now);
  if (!hookActivity) return transcriptActivity;

  const hookAt = Date.parse(hookActivity.lastEventAt || "");
  if (!Number.isFinite(hookAt)) return transcriptActivity;
  const lastAt = Math.max(hookAt, Number.isFinite(facts.latestAt) ? facts.latestAt : -Infinity);
  const base = {
    ...hookActivity,
    lastEventAt: new Date(lastAt).toISOString(),
    staleMs: now - lastAt,
  };

  if (CLAUDE_TURN_OPEN_STATES.has(hookActivity.state)) {
    if (Number.isFinite(facts.interruptAt) && facts.interruptAt >= hookAt) {
      return endedClaudeActivity(base, "interrupted", "claude_jsonl");
    }
    if (hookActivity.state === "approval") {
      return now - hookAt > CLAUDE_APPROVAL_STALE_MS ? endedClaudeActivity(base, "approval expired") : base;
    }
    return now - lastAt > CLAUDE_OPEN_TURN_STALE_MS ? endedClaudeActivity(base, "no recent Claude event") : base;
  }

  // The turn ended per the hooks, but the transcript moved on afterwards: a turn the
  // hooks did not see (e.g. hooks installed after the session started), or
  // background subagents still at work.
  const movedOn = [facts.latestMessageAt, facts.latestSidechainAt].some((at) => {
    return Number.isFinite(at) && at > hookAt + CLAUDE_HOOK_CLOCK_SLACK_MS;
  });
  if (movedOn && CLAUDE_TURN_OPEN_STATES.has(transcriptActivity.state)) {
    return transcriptActivity;
  }

  return base;
}

function endedClaudeActivity(activity, detail, source = activity.source) {
  const { action, ...rest } = activity;
  return { ...rest, state: "idle", detail, source };
}

function findOpenClaudeTool(parsedEvents) {
  const open = new Map();

  for (const event of parsedEvents) {
    for (const toolUse of event.toolUses) {
      open.set(toolUse.id || `index:${open.size}`, toolUse);
    }

    for (const toolResult of event.toolResults) {
      if (toolResult.toolUseId && open.has(toolResult.toolUseId)) {
        open.delete(toolResult.toolUseId);
      } else {
        const latestKey = Array.from(open.keys()).at(-1);
        if (latestKey) open.delete(latestKey);
      }
    }
  }

  return Array.from(open.values()).at(-1) || null;
}

// options.bridge: a readClaudeBridgeSnapshot() result; each session only takes the
// hook activity and statusline recorded under its own session_id.
// options.usageFiles: when set, only entries of these files count toward usage.
function summarizeClaudeSessions(fileEntries, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const bridgeSessions = options.bridge && options.bridge.sessions instanceof Map ? options.bridge.sessions : new Map();
  const sessions = new Map();
  const entriesBySession = new Map();
  const parsedBySession = new Map();

  for (const { filePath, entry } of fileEntries) {
    const parsed = parseClaudeEntry(entry);
    if (!parsed.sessionId) continue;
    // Subagent transcripts (<session>/subagents/**.jsonl) carry the parent's sessionId.
    if (isClaudeSubagentFile(filePath)) parsed.sidechain = true;
    if (!entriesBySession.has(parsed.sessionId)) {
      entriesBySession.set(parsed.sessionId, []);
      parsedBySession.set(parsed.sessionId, []);
    }
    if (!options.usageFiles || options.usageFiles.has(filePath)) entriesBySession.get(parsed.sessionId).push(entry);
    parsedBySession.get(parsed.sessionId).push(parsed);

    const existing = sessions.get(parsed.sessionId) || {
      id: parsed.sessionId,
      title: null,
      cwd: parsed.cwd || null,
      project: projectNameFromFile(filePath),
      updatedAt: null,
      model: null,
      source: "claude_jsonl",
    };

    if (!parsed.sidechain) {
      if (parsed.cwd) existing.cwd = parsed.cwd;
      if (parsed.model) existing.model = parsed.model;
    }
    if (!existing.updatedAt || compareTimestamp(parsed.timestamp, existing.updatedAt) > 0) {
      existing.updatedAt = parsed.timestamp;
    }

    sessions.set(parsed.sessionId, existing);
  }

  for (const [sessionId, session] of sessions) {
    const entries = entriesBySession.get(sessionId) || [];
    const facts = claudeTranscriptFacts(parsedBySession.get(sessionId) || []);
    const prompts = claudeUserPrompts(parsedBySession.get(sessionId) || []);
    session.title = prompts.first;
    session.latestTitle = prompts.latest;
    // Only subagent transcripts were read for this session: not a session of its own.
    if (!facts.latestMain) session.internal = true;

    const bridgeSession = bridgeSessions.get(sessionId);
    applyClaudeStatusLine(session, bridgeSession && bridgeSession.status);
    session.activity = combineClaudeActivity(bridgeSession && bridgeSession.activity, facts, now);
    // Sessions read only to list them (beyond the usage files) carry no usage.
    session.usage = entries.length > 0 || !options.usageFiles ? summarizeClaudeUsageForSession(entries) : null;
  }

  return Array.from(sessions.values()).sort((a, b) => compareTimestamp(b.updatedAt, a.updatedAt));
}

// First and latest prompt the user typed on the main chain, in transcript order.
function claudeUserPrompts(parsedEvents) {
  const prompts = parsedEvents
    .filter((event) => !event.sidechain && event.userText)
    .map((event, index) => ({ event, index, at: Date.parse(event.timestamp || "") }))
    .sort((a, b) => {
      if (Number.isFinite(a.at) && Number.isFinite(b.at) && a.at !== b.at) return a.at - b.at;
      return a.index - b.index;
    })
    .map(({ event }) => event.userText);
  return { first: prompts[0] || null, latest: prompts.at(-1) || null };
}

function applyClaudeStatusLine(session, status) {
  if (!session || !status) return;
  session.title = status.sessionName || session.title;
  session.cwd = status.cwd || session.cwd;
  session.model = status.model || session.model;
  session.agentName = status.agentName || null;
  session.source = "claude_statusline";
}

// <project>/<session uuid>/subagents/**.jsonl
function isClaudeSubagentFile(filePath) {
  return claudeSubagentSegment(filePath) >= 0;
}

function claudeSubagentParentId(filePath) {
  const index = claudeSubagentSegment(filePath);
  return index >= 0 ? filePath.split(/[\\/]+/)[index - 1] : null;
}

function claudeSubagentSegment(filePath) {
  const parts = typeof filePath === "string" ? filePath.split(/[\\/]+/) : [];
  return parts.findIndex((part, index) => {
    return part === "subagents" && index >= 2 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[index - 1]);
  });
}

// Reads the bridge file written by the hooks and statusline that
// claudeBridgeInstall.js installs. Every record is
// { timestamp, source: "hook" | "statusline", type, hook_type, data } where data is
// Claude Code's own hook / statusline JSON, which carries session_id. Keeps, per
// session, the newest hook that says whether its turn is running, and its newest
// statusline.
function readClaudeBridgeSnapshot(bridgePath, options = {}) {
  if (!bridgePath || !pathExists(bridgePath)) {
    if (bridgePath) claudeBridgeCache.delete(bridgePath);
    return null;
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const state = readClaudeBridgeState(bridgePath, options.maxBytes || CLAUDE_BRIDGE_TAIL_BYTES);
  if (!state || state.records === 0) return null;
  pruneClaudeBridgeState(state, now);

  const sessions = new Map();
  for (const [sessionId, entry] of state.sessions) {
    sessions.set(sessionId, {
      activity: withStaleMs(entry.activity, now),
      status: entry.status,
      lastEventAt: entry.lastEventAt,
    });
  }

  return {
    source: "claude_bridge",
    bridgePath,
    latestEventAt: state.latestEventAt,
    status: state.latestStatus,
    activity: withStaleMs(state.latestActivity, now),
    sessions,
  };
}

const claudeBridgeCache = new Map();

function readClaudeBridgeState(bridgePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(bridgePath, "r");
    const stat = fs.fstatSync(fd);
    let state = claudeBridgeCache.get(bridgePath);
    if (state && !claudeBridgeStateMatches(fd, stat, state)) state = null;
    if (!state) state = createClaudeBridgeState(stat);

    let start = state.offset;
    let midLine = state.midLine;
    if (stat.size - start > maxBytes) {
      start = stat.size - maxBytes;
      midLine = start > 0;
    }

    const length = stat.size - start;
    if (length > 0) {
      const buffer = readBytes(fd, start, length);
      // Started inside a line: skip to the next line start, if any.
      let begin = 0;
      let atLineStart = !midLine;
      if (midLine) {
        const newline = buffer.indexOf(0x0a);
        atLineStart = newline >= 0;
        begin = atLineStart ? newline + 1 : buffer.length;
      }
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (atLineStart && lastNewline >= begin) {
        for (const line of buffer.toString("utf8", begin, lastNewline + 1).split("\n")) {
          if (!line.trim()) continue;
          try {
            applyClaudeBridgeRecord(state, JSON.parse(line));
          } catch {
            // ignore a malformed line
          }
        }
        state.offset = start + lastNewline + 1;
      } else {
        // No complete line yet: resume at `begin` (the start of a line still being
        // written, or the end of the file while inside an overlong line).
        state.offset = start + begin;
      }
      state.midLine = !atLineStart;
      const fingerprintLength = Math.min(CLAUDE_BRIDGE_FINGERPRINT_BYTES, state.offset);
      state.fingerprint = readBytes(fd, state.offset - fingerprintLength, fingerprintLength);
    }

    claudeBridgeCache.set(bridgePath, state);
    return state;
  } catch {
    claudeBridgeCache.delete(bridgePath);
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function createClaudeBridgeState(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    offset: 0,
    midLine: false,
    fingerprint: Buffer.alloc(0),
    records: 0,
    latestEventAt: null,
    latestStatus: null,
    latestActivity: null,
    sessions: new Map(),
  };
}

// Same file, only appended to since the last read (not truncated, rotated or rewritten).
function claudeBridgeStateMatches(fd, stat, state) {
  if (state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.offset) return false;
  const length = state.fingerprint.length;
  if (length === 0) return state.offset === 0;
  return readBytes(fd, state.offset - length, length).equals(state.fingerprint);
}

function readBytes(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const bytes = fs.readSync(fd, buffer, read, length - read, position + read);
    if (bytes <= 0) break;
    read += bytes;
  }
  return read < length ? buffer.subarray(0, read) : buffer;
}

function applyClaudeBridgeRecord(state, record) {
  if (!record || typeof record !== "object") return;
  const data = record.data && typeof record.data === "object" ? record.data : record;
  const timestamp = record.timestamp || record.receivedAt || null;
  const sessionId = data.session_id || data.sessionId || record.session_id || record.sessionId || null;
  const isStatusLine = record.source === "statusline" || record.type === "statusline";
  const hookType = isStatusLine ? null : claudeHookType(record);
  if (!isStatusLine && !hookType) return;

  state.records += 1;
  if (timestamp) state.latestEventAt = timestamp;
  const session = sessionId ? state.sessions.get(sessionId) || { activity: null, status: null, lastEventAt: null } : null;
  if (session) {
    session.lastEventAt = timestamp || session.lastEventAt;
    state.sessions.set(sessionId, session);
  }

  if (isStatusLine) {
    const status = normalizeClaudeStatusLine(record);
    state.latestStatus = status;
    if (session) session.status = status;
    return;
  }

  const activity = claudeHookActivity(record);
  if (!activity) return;
  state.latestActivity = activity;
  if (!session) return;
  // Claude Code sends PermissionRequest (with the tool input) and, 6s later, a
  // permission_prompt Notification (message only) for the same prompt: keep the first.
  const keepPrevious = activity.state === "approval"
    && hookType === "Notification"
    && session.activity
    && session.activity.state === "approval"
    && session.activity.hookType === "PermissionRequest";
  if (!keepPrevious) session.activity = activity;
}

function pruneClaudeBridgeState(state, now) {
  for (const [sessionId, session] of state.sessions) {
    const at = Date.parse(session.lastEventAt || "");
    if (Number.isFinite(at) && now - at > CLAUDE_BRIDGE_SESSION_TTL_MS) state.sessions.delete(sessionId);
  }
}

function withStaleMs(activity, now) {
  if (!activity) return null;
  const at = Date.parse(activity.lastEventAt || "");
  return { ...activity, staleMs: Number.isFinite(at) ? now - at : null };
}

function normalizeClaudeStatusLine(event) {
  const data = event.data || event;
  return {
    sessionId: data.session_id || data.sessionId || null,
    sessionName: data.session_name || data.sessionName || null,
    cwd: data.cwd || data.workspace || null,
    model: data.model && (data.model.display_name || data.model.name) || data.model || null,
    agentName: data.agent && data.agent.name || data.agent_name || null,
    contextWindow: data.context_window || data.contextWindow || null,
    rateLimits: data.rate_limits || data.rateLimits || null,
    source: "claude_statusline",
  };
}

// The activity a bridge hook record implies for its session, or null when the hook
// says nothing about whether the session's turn is running (it then leaves the
// session's previous hook state in place).
function normalizeClaudeHookActivity(event, now = Date.now()) {
  return withStaleMs(claudeHookActivity(event), now);
}

function claudeHookType(event) {
  const data = event && event.data && typeof event.data === "object" ? event.data : event || {};
  return event && (event.hook_type || event.hookType) || data.hook_event_name || event && event.type || null;
}

function claudeHookActivity(event) {
  const hookType = claudeHookType(event);
  if (!hookType || hookType === "statusline") return null;
  const data = event.data && typeof event.data === "object" ? event.data : event;
  const timestamp = event.timestamp || event.receivedAt || null;
  const activity = (state, detail, extra = {}) => ({
    state,
    detail,
    ...extra,
    confidence: "high",
    source: "claude_hooks",
    hookType,
    lastEventAt: timestamp,
  });
  const toolName = data.tool_name || data.toolName || data.name || null;
  const toolInput = data.tool_input || data.toolInput || data.input;

  switch (hookType) {
    case "PreToolUse":
      return activity("tool", toolName || "tool_use", { action: summarizeToolAction(toolName || "tool_use", toolInput) });
    // Fires when Claude Code shows a permission dialog.
    case "PermissionRequest":
      return activity("approval", toolName || "approval", { action: summarizeToolAction(toolName || "approval", toolInput) });
    case "UserPromptSubmit":
      return activity("working", hookType);
    case "PostToolUse":
    case "PostToolBatch":
    case "PermissionDenied":
      return activity("waiting", hookType);
    case "PostToolUseFailure":
      // Esc while a tool runs: the turn ends without a Stop hook.
      return data.is_interrupt === true ? activity("idle", "interrupted") : activity("waiting", hookType);
    case "Notification":
      return claudeNotificationActivity(data, activity);
    // The turn ended (StopFailure: it ended on an API error).
    case "Stop":
    case "StopFailure":
      return activity("idle", "stop");
    case "SessionStart":
      // source "compact" fires in the middle of a turn that auto-compacted.
      return data.source === "compact" ? null : activity("idle", "session started");
    case "SessionEnd":
      return activity("idle", "session ended");
    default:
      // SubagentStart/Stop, TaskCreated/Completed and Pre/PostCompact fire inside a
      // turn (or for background agents) without starting or ending it; unknown
      // hooks are treated the same.
      return null;
  }
}

function claudeNotificationActivity(data, activity) {
  const type = data.notification_type || data.notificationType || null;
  if (type && CLAUDE_NEUTRAL_NOTIFICATIONS.has(type)) return null;
  if (type !== "idle_prompt" && (CLAUDE_APPROVAL_NOTIFICATIONS.has(type) || looksLikeApprovalNotification(data))) {
    const toolName = data.tool_name || data.toolName || data.name || approvalToolFromMessage(data.message) || "approval";
    return activity("approval", toolName, {
      action: summarizeToolAction(toolName, data.tool_input || data.toolInput || data.input) || approvalActionFromMessage(data.message),
    });
  }
  // idle_prompt ("Claude is waiting for your input") and other notifications without
  // a permission prompt are sent once the turn is over.
  return activity("idle", type || "notification");
}

function looksLikeApprovalNotification(data) {
  return isApprovalText(data && data.message)
    || isApprovalText(data && data.detail)
    || isApprovalText(data && data.reason);
}

function approvalToolFromMessage(message) {
  if (typeof message !== "string") return null;
  const match = message.match(/\b(?:use|run|execute)\s+([A-Za-z_][\w-]*)\s*(?::|$)/i);
  return match ? match[1] : null;
}

function approvalActionFromMessage(message) {
  if (typeof message !== "string") return null;
  const match = message.match(/:\s*(.+)$/);
  return match ? match[1].trim() : message.trim();
}

function isApprovalText(text) {
  if (!text) return false;
  return /\b(needs?|requires?|waiting|awaiting|request(?:ing|ed)?|confirm)\b[\s\S]{0,80}\b(approval|permission|confirmation|confirm|sandbox|escalation)\b/i.test(text)
    || /\b(approval|permission|confirmation|confirm|sandbox|escalation)\b[\s\S]{0,80}\b(needs?|requires?|waiting|awaiting|request(?:ing|ed)?|confirm)\b/i.test(text);
}

async function collectClaudeSnapshot(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const includeUsage = options.includeUsage !== false;
  const includeQuota = options.includeQuota !== false;
  const maxFiles = options.maxFiles || 30;
  const roots = options.projectRoots || resolveClaudeProjectRoots(options.env);
  const existingRoots = roots.filter(pathExists);
  const mtimes = new Map();
  const mtimeOf = (filePath) => {
    if (!mtimes.has(filePath)) mtimes.set(filePath, safeMtimeMs(filePath));
    return mtimes.get(filePath);
  };
  const files = existingRoots.flatMap(walkJsonlFiles)
    .sort((a, b) => mtimeOf(b) - mtimeOf(a));
  // Usage reads the newest files of any kind as before (it counts subagent tokens).
  // Subagent transcripts can crowd sessions out of those: sessions touched in the
  // last hours, and the parents of the subagents read, are read too, so no session
  // that may still run or await approval is missed.
  const usageFiles = new Set(files.slice(0, maxFiles));
  const sessionFiles = files.filter((filePath) => !isClaudeSubagentFile(filePath));
  const parentSessionIds = new Set(Array.from(usageFiles, claudeSubagentParentId).filter(Boolean));
  const crowdedOut = sessionFiles
    .filter((filePath) => {
      if (usageFiles.has(filePath)) return false;
      return now - mtimeOf(filePath) <= CLAUDE_APPROVAL_STALE_MS
        || parentSessionIds.has(path.basename(filePath, ".jsonl"));
    })
    .slice(0, maxFiles);
  const selectedFiles = [...usageFiles, ...crowdedOut];
  const fileEntries = readJsonlFiles(selectedFiles, options.maxLinesPerFile || 200);
  const latestSessionFile = sessionFiles[0] || null;
  const bridgePath = options.bridgePath || resolveClaudeBridgePath(options.env);
  const bridge = readClaudeBridgeSnapshot(bridgePath, { now });
  const sessions = summarizeClaudeSessions(fileEntries, { now, bridge, usageFiles });
  if (!includeUsage) {
    for (const session of sessions) session.usage = null;
  }
  let activeSession = sessions.find((session) => !session.internal) || null;

  // The session whose statusline refreshed last is the one in front of the user.
  if (bridge && bridge.status && bridge.status.sessionId) {
    const session = sessions.find((item) => item.id === bridge.status.sessionId && !item.internal);
    if (session) {
      activeSession = session;
    } else if (!sessions.some((item) => item.id === bridge.status.sessionId)) {
      const bridgeSession = bridge.sessions.get(bridge.status.sessionId);
      activeSession = {
        id: bridge.status.sessionId,
        title: bridge.status.sessionName,
        cwd: bridge.status.cwd,
        project: bridge.status.cwd ? path.basename(bridge.status.cwd) : null,
        updatedAt: bridgeSession && bridgeSession.lastEventAt || bridge.latestEventAt,
        model: bridge.status.model,
        agentName: bridge.status.agentName,
        activity: combineClaudeActivity(bridgeSession && bridgeSession.activity, claudeTranscriptFacts([]), now),
        source: "claude_statusline",
      };
      sessions.unshift(activeSession);
    }
  }

  const activity = activeSession && activeSession.activity
    || inferClaudeActivity(latestSessionFile ? readJsonlTail(latestSessionFile, options.maxLines || 240) : [], null, now);

  return {
    provider: "claude",
    source: {
      projectRoots: existingRoots,
      bridgePath,
      bridgeAvailable: Boolean(bridge),
      latestSessionFile,
    },
    sessions,
    activeSession,
    activity,
    usage: includeUsage
      ? summarizeClaudeUsage(fileEntries.filter((item) => usageFiles.has(item.filePath)))
      : null,
    quota: includeQuota && bridge && bridge.status ? {
      source: "claude_statusline",
      rateLimits: bridge.status.rateLimits,
      contextWindow: bridge.status.contextWindow,
    } : null,
    fileStats: {
      projectFiles: files.length,
      scannedFiles: selectedFiles.length,
      latestSessionMtimeMs: latestSessionFile ? mtimeOf(latestSessionFile) : null,
    },
  };
}

function projectNameFromFile(filePath) {
  // <project>/<session>/subagents/**.jsonl belongs to <project>.
  const subagents = claudeSubagentSegment(filePath);
  if (subagents >= 2) return filePath.split(/[\\/]+/)[subagents - 2];
  const parent = path.dirname(filePath);
  return path.basename(parent);
}

function compareTimestamp(a, b) {
  const aTime = Date.parse(a || "");
  const bTime = Date.parse(b || "");
  if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0;
  if (!Number.isFinite(aTime)) return -1;
  if (!Number.isFinite(bTime)) return 1;
  return aTime - bTime;
}

function numberFrom(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

module.exports = {
  collectClaudeSnapshot,
  extractClaudeUsage,
  inferClaudeActivity,
  normalizeClaudeHookActivity,
  normalizeClaudeStatusLine,
  parseClaudeEntry,
  readClaudeBridgeSnapshot,
  summarizeClaudeSessions,
  summarizeClaudeUsage,
  summarizeClaudeUsageForSession,
};
