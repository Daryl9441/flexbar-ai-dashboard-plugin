"use strict";

const { collectCodexSnapshot } = require("./codex");
const { collectCodexAutomations } = require("./codexAutomations");

// options.codex: Codex collector options (codexHome, env, ...); the scheduled tasks are
// read from the same Codex home. options.automations: false skips them, an object adds
// options for collectCodexAutomations (tests).
async function collectAiSnapshot(options = {}) {
  const startedAt = new Date();
  const codexOptions = options.codex || {};
  const codex = await collectCodexSnapshot(codexOptions);
  const automations = options.automations === false
    ? undefined
    : collectAutomationsSafely(codexOptions, options.automations);

  const snapshot = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
    providers: {
      codex,
    },
  };
  if (automations) snapshot.automations = automations;
  return snapshot;
}

// collectCodexAutomations never throws by contract; this keeps a bug in it from
// costing the whole snapshot.
function collectAutomationsSafely(codexOptions, extra) {
  try {
    return collectCodexAutomations({
      codexHome: codexOptions.codexHome,
      env: codexOptions.env,
      ...(extra && typeof extra === "object" ? extra : {}),
    });
  } catch {
    return { available: false, reason: "readFailed", stale: false, total: 0, items: [] };
  }
}

function compactSnapshot(snapshot) {
  const compact = {
    collectedAt: snapshot.collectedAt,
    elapsedMs: snapshot.elapsedMs,
    codex: compactProvider(snapshot.providers.codex),
  };
  if (snapshot.automations) compact.automations = compactAutomations(snapshot.automations);
  return compact;
}

// Logged on every change: counts only, never task names.
function compactAutomations(automations) {
  return {
    available: Boolean(automations.available),
    reason: automations.reason ?? null,
    total: Number(automations.total) || 0,
  };
}

function compactProvider(provider) {
  const session = provider.activeSession;
  return {
    state: provider.activity && provider.activity.state,
    detail: provider.activity && provider.activity.detail,
    confidence: provider.activity && provider.activity.confidence,
    title: session && (session.title || session.project || session.id),
    cwd: session && session.cwd,
    updatedAt: session && session.updatedAt,
    latestTurn: provider.usage && provider.usage.latestTurn,
    sessionCount: provider.sessions ? provider.sessions.length : 0,
    files: provider.fileStats,
    source: provider.source,
  };
}

module.exports = {
  collectAiSnapshot,
  compactSnapshot,
};
