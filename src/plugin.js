"use strict";

const { plugin, logger } = require("@eniac/flexdesigner");
const { collectAiSnapshot, compactSnapshot } = require("./collectors/snapshot");
const { applyUsageCache, captureUsageCache } = require("./collectors/usageCache");
const {
  applyOverviewTitleMode,
  applySessionTitleMode,
  buildAutomationOverview,
  buildDashboardViewModel,
  buildSessionOverview,
  createDashboardState,
} = require("./dashboard/viewModel");
const {
  renderAutomationOverviewKey,
  renderNewSessionKey,
  renderPlanUsageKey,
  renderResetTimerKey,
  renderSessionKey,
  renderSessionOverviewKey,
  renderTokenUsageKey,
  sessionOverviewLayout,
} = require("./dashboard/render");
const { renderDotsKey } = require("./dashboard/dotsRender");
const { createDotsKeyController } = require("./dashboard/dotsKey");
const {
  extractDeviceStatuses,
  extractInteractionKey,
  extractLoadedKeys,
  languageFromPayload,
  newSessionConfigFromKey,
  sessionTitleModeFromKey,
  tokenDisplayModeFromKey,
} = require("./dashboard/pluginEvents");
const {
  createRateLimitedLogger,
  installUnhandledRejectionGuard,
  safeCall,
  waitAtMost,
} = require("./dashboard/hostSafety");
const { createKeyDrawCache } = require("./dashboard/keyDrawCache");
const { SESSION_KEY_MODE, nextSessionKeyMode } = require("./dashboard/sessionKeyMode");
const { DEFAULT_LANGUAGE, t } = require("./dashboard/i18n");
const { applySkillInvocation } = require("./dashboard/skillAction");
const {
  listRecentProjectPaths,
  openNewCodexSession,
  projectLabel,
} = require("./dashboard/newSessionAction");
const { configureDefaultSkillKey, skillNameFromKey } = require("./dashboard/skillKey");
const { listAiSkills } = require("./collectors/skills");
const {
  collectorOptionsFromConfig,
  listPathDefaults,
  normalizePluginConfig,
} = require("./collectors/pathOverrides");
const { validatePathOverrides } = require("./collectors/pathOverrideValidation");
const {
  loadPluginConfigState,
  mergePluginConfigs,
  writePluginConfigFile,
} = require("./collectors/pluginConfigStorage");
const { getSetupStatus } = require("./collectors/setup");

const SESSION_CID = "com.aspen.flexbar-ai-dashboard.session";
const TOKEN_USAGE_CID = "com.aspen.flexbar-ai-dashboard.token-usage";
const PLAN_USAGE_CID = "com.aspen.flexbar-ai-dashboard.plan-usage";
const SKILL_CID = "com.aspen.flexbar-ai-dashboard.skill";
const RESET_TIMER_CID = "com.aspen.flexbar-ai-dashboard.reset-timer";
const NEW_SESSION_CID = "com.aspen.flexbar-ai-dashboard.new-session";
const DOTS_CID = "com.aspen.flexbar-ai-dashboard.dots";
const DASHBOARD_CIDS = new Set([SESSION_CID, TOKEN_USAGE_CID, PLAN_USAGE_CID, RESET_TIMER_CID, SKILL_CID, NEW_SESSION_CID, DOTS_CID]);
const SNACKBAR_MAX_LENGTH = 63;
const SESSION_INTERVAL_MS = 2_000;
// Keys that need no AI snapshot (a lone New Codex Session key) still get this
// slow redraw tick, so the cache's periodic re-send and the probe of an
// unplugged device keep working without running the snapshot collectors.
const KEY_REDRAW_INTERVAL_MS = 15_000;
// Redraw a reconnected device slightly after keyDrawCache stops holding its draws.
const RECONNECT_REDRAW_MARGIN_MS = 100;
// The SDK sends getConfig()/setConfig() without a timeout; never let a host
// that does not answer block key drawing or the settings page.
const HOST_CONFIG_SYNC_TIMEOUT_MS = 5_000;
const HOST_CONFIG_SAVE_TIMEOUT_MS = 10_000;
const USAGE_INTERVAL_MS = 30_000;
const SNAPSHOT_LOG_HEARTBEAT_MS = 60_000;

// Host calls reject whenever the Flexbar drops off USB; route them through
// safeCall/keyDrawCache and keep a last-resort guard so a stray rejection is
// logged instead of exiting the process (FlexDesigner stops restarting the
// plugin after five crashes, leaving every key on its default icon).
const hostLog = createRateLimitedLogger(logger);
installUnhandledRejectionGuard(process, hostLog);
const keyDrawCache = createKeyDrawCache({
  draw: (serialNumber, key, type, base64) => plugin.draw(serialNumber, key, type, base64),
  log: hostLog,
  onDeviceRecovered: () => drawDashboardKeys(),
});

const keyData = {};
const dashboardKeys = new Map();
const assignedSessionByKey = new Map();
// What each AI Session key shows besides its own session (absent = home): taps
// cycle home -> overview -> automations -> home. The finished sessions a key's
// overview is showing are marked viewed when it moves on.
const sessionKeyModes = new Map();
const overviewDoneSessionsByKey = new Map();
const dashboardState = createDashboardState();
let latestSnapshot = null;
let snapshotTimer = null;
let redrawTimer = null;
let reconnectRedrawTimer = null;
let snapshotInFlight = false;
let usageCache = null;
let lastUsageAt = 0;
let currentLanguage = DEFAULT_LANGUAGE;
let lastLoggedSnapshot = "";
let lastSnapshotLogAt = 0;
const initialPluginConfigState = loadPluginConfigState(plugin.directory);
let pluginConfig = initialPluginConfigState.config;
// Bumped whenever the config is saved or pushed by the host, so a getConfig()
// answer that was requested before that change cannot overwrite it.
let pluginConfigRevision = 0;
let hostPluginConfigSynced = false;
// { promise, deadline } while the host has not answered getConfig().
let hostConfigSync = null;

if (initialPluginConfigState.warning) {
  logger.warn(initialPluginConfigState.warning);
}

// The ChatGPT Dots keys share one status poller that runs only while one is loaded (src/dashboard/dotsKey.js).
const dotsKey = createDotsKeyController({
  getPluginConfig: () => pluginConfig,
  ready: () => waitForHostPluginConfigSync(),
  notify,
  onUpdate: () => drawDashboardKeys(),
  log: logger,
});

plugin.on("ui.message", async (payload) => {
  updateHostLanguage(payload);
  // Bounded: a host that never answers getConfig() delays one reply by at most
  // HOST_CONFIG_SYNC_TIMEOUT_MS instead of hanging the settings page.
  await ensureHostPluginConfigSynced();

  if (payload && payload.type === "language") {
    return { language: currentLanguage };
  }

  if (payload && payload.type === "snapshot") {
    return payload.full ? latestSnapshot : latestSnapshot && compactSnapshot(latestSnapshot);
  }

  if (payload && payload.type === "skills") {
    return listAiSkills(collectorOptionsFromConfig(pluginConfig));
  }

  if (payload && payload.type === "recentProjects") {
    return listRecentProjectPaths(isFreshSnapshot(latestSnapshot) ? latestSnapshot : await collectRecentProjectsSnapshot());
  }

  if (payload && payload.type === "pathDefaults") {
    return listPathDefaults();
  }

  if (payload && payload.type === "getPluginConfig") {
    return pluginConfig;
  }

  if (payload && payload.type === "savePluginConfig") {
    return savePluginConfig(payload.config);
  }

  if (payload && payload.type === "setupStatus") {
    return getSetupStatus(collectorOptionsFromConfig(pluginConfig));
  }

  if (payload && payload.type === "dotsStatus") {
    return dotsKey.status();
  }

  logger.info("Received message from UI:", payload);
  return "Hello from plugin backend!";
});

plugin.on("device.status", (devices) => {
  logger.info("Device status changed:", devices);
  handleDeviceStatus(devices);
});

plugin.on("plugin.alive", async (payload) => {
  logger.info("Plugin alive:", payload);
  updateHostLanguage(payload);
  // Ask the host for its config first so the first snapshot can wait for it,
  // but draw the keys right away: getConfig() has no SDK timeout, and keys
  // must never stay on their default icon because the host did not answer.
  const configSynced = ensureHostPluginConfigSynced();
  handleKeysLoaded(payload);
  await configSynced;
});

plugin.on("device.newPage", (payload) => {
  logger.info("Device newPage:", payload);
  updateHostLanguage(payload);
  handleKeysLoaded(payload);
});

plugin.on("plugin.dead", (payload) => {
  logger.info("Plugin dead:", payload);
  updateHostLanguage(payload);
  handleKeysRemoved(payload);
});

plugin.on("plugin.data", async (payload) => {
  logger.info("Received plugin.data:", payload);
  updateHostLanguage(payload);
  await runInBackground("handleKeyInteraction", () => handleKeyInteraction(payload));
});

plugin.on("device.userData", async (payload) => {
  logger.info("Received device.userData:", payload);
  updateHostLanguage(payload);
  await runInBackground("handleKeyInteraction", () => handleKeyInteraction(payload));
});

plugin.on("plugin.config.updated", (payload) => {
  logger.info("Plugin config updated:", payload);
  updateHostLanguage(payload);
  pluginConfig = mergePluginConfigs(pluginConfig, payload && (payload.config ?? payload));
  pluginConfigRevision += 1;
  writePluginConfigFile(plugin.directory, pluginConfig);
  dotsKey.configChanged();
  if (hasSnapshotKeys()) {
    refreshSnapshotInBackground();
    return;
  }
  drawDashboardKeys();
});

/**
 * Merges the host's copy of the plugin config once. Resolves when it is
 * merged, or at the latest HOST_CONFIG_SYNC_TIMEOUT_MS after it was requested:
 * the SDK sends getConfig() without a timeout, so a host that never answers
 * would otherwise block every caller forever. Never rejects.
 */
function ensureHostPluginConfigSynced() {
  return waitForHostPluginConfigSync(startHostPluginConfigSync());
}

function startHostPluginConfigSync() {
  if (hostPluginConfigSynced || typeof plugin.getConfig !== "function") return null;
  if (hostConfigSync) return hostConfigSync;

  const revision = pluginConfigRevision;
  const sync = { deadline: Date.now() + HOST_CONFIG_SYNC_TIMEOUT_MS, promise: null };
  hostConfigSync = sync;
  sync.promise = callHost("Sync plugin config from host", () => plugin.getConfig())
    .then((result) => applyHostPluginConfig(result, revision))
    .catch((error) => hostLog.warn("configSync", "Failed to apply host plugin config:", error))
    .finally(() => {
      if (hostConfigSync === sync) hostConfigSync = null;
    });
  return sync;
}

/** Waits (bounded) for a pending getConfig() without sending a new one. */
function waitForHostPluginConfigSync(sync = hostConfigSync) {
  if (!sync) return Promise.resolve(false);
  return waitAtMost(sync.promise, sync.deadline - Date.now());
}

function applyHostPluginConfig(result, revision) {
  // Unanswered with an error: stay unsynced so the next ui.message or
  // plugin.alive asks again.
  if (!result.ok) return;
  hostPluginConfigSynced = true;
  if (revision !== pluginConfigRevision) {
    // Saved or pushed while this (late) answer was pending: the newer config wins.
    logger.info("Ignoring host plugin config answer that predates a newer config change");
    return;
  }

  try {
    pluginConfig = mergePluginConfigs(pluginConfig, result.value);
    writePluginConfigFile(plugin.directory, pluginConfig);
    dotsKey.configChanged();
  } catch (error) {
    hostPluginConfigSynced = false;
    logger.warn("Failed to sync plugin config from host:", error);
  }
}

async function savePluginConfig(config) {
  const candidate = normalizePluginConfig(config);
  const validation = validatePathOverrides(candidate);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  pluginConfig = candidate;
  pluginConfigRevision += 1;
  writePluginConfigFile(plugin.directory, pluginConfig);
  dotsKey.configChanged();

  if (typeof plugin.setConfig === "function") {
    const result = await callHost(
      "Save plugin config",
      () => plugin.setConfig(pluginConfig),
      "error",
      HOST_CONFIG_SAVE_TIMEOUT_MS
    );
    if (!result.ok) {
      const { error } = result;
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  if (dashboardKeys.size > 0) {
    await refreshSnapshot();
  }

  return { ok: true, config: pluginConfig };
}

function updateHostLanguage(payload) {
  const language = languageFromPayload(payload);
  if (language && language !== currentLanguage) {
    currentLanguage = language;
    keyDrawCache.invalidateAll();
    drawDashboardKeys();
  }
}

function handleDeviceStatus(payload) {
  // A reconnected device was reset while it was away, so all of its keys are
  // redrawn. FlexDesigner reloads them with plugin.alive about 0.5s later,
  // which redraws them at once; keyDrawCache holds the device's draws until
  // then so each key is drawn once. Redraw after the grace period in case that
  // reload never comes.
  const statuses = extractDeviceStatuses(payload);
  dotsKey.applyDeviceStatuses(statuses);
  const reconnected = keyDrawCache.applyDeviceStatuses(statuses);
  if (reconnected.some(hasDashboardKeysOn)) scheduleReconnectRedraw();
}

function scheduleReconnectRedraw() {
  if (reconnectRedrawTimer) clearTimeout(reconnectRedrawTimer);
  reconnectRedrawTimer = setTimeout(() => {
    reconnectRedrawTimer = null;
    drawDashboardKeys();
  }, keyDrawCache.reloadGraceMs + RECONNECT_REDRAW_MARGIN_MS);
}

function hasDashboardKeysOn(serialNumber) {
  for (const item of dashboardKeys.values()) {
    if (item.serialNumber === serialNumber) return true;
  }
  return false;
}

function handleKeysLoaded(payload) {
  const { serialNumber, keys } = extractLoadedKeys(payload);
  if (!serialNumber) {
    logger.warn("Ignoring key load event without serialNumber:", payload);
    return;
  }

  // Freshly loaded keys show their default look on the device, so they must
  // be drawn again even if our cache says the content did not change.
  keyDrawCache.markKeysLoaded(serialNumber, keys);
  dotsKey.deviceConnected(serialNumber);
  const aliveKeys = new Set(keys.map((key) => key.uid));
  let loadedDashboardKey = false;

  for (const key of keys) {
    keyData[key.uid] = key;

    if (DASHBOARD_CIDS.has(key.cid)) {
      const type = dashboardKeyType(key.cid);
      dashboardKeys.set(key.uid, {
        serialNumber,
        key,
        type,
      });
      loadedDashboardKey = true;
    }
  }

  for (const [uid, item] of dashboardKeys.entries()) {
    if (item.serialNumber === serialNumber && !aliveKeys.has(uid)) {
      dashboardKeys.delete(uid);
      assignedSessionByKey.delete(uid);
      forgetSessionKeyMode(uid);
      keyDrawCache.invalidateKey(serialNumber, uid);
    }
  }

  // Shows the latest data right away, or "loading" until the first snapshot.
  if (loadedDashboardKey) drawDashboardKeys();
  syncRefreshLoops();
}

function handleKeysRemoved(payload) {
  const { serialNumber, keys } = extractLoadedKeys(payload);
  const keyIds = new Set(keys.map((key) => key.uid));

  for (const [uid, item] of dashboardKeys.entries()) {
    const sameDevice = !serialNumber || item.serialNumber === serialNumber;
    const listedKey = keyIds.size === 0 || keyIds.has(uid);
    if (sameDevice && listedKey) {
      dashboardKeys.delete(uid);
      assignedSessionByKey.delete(uid);
      forgetSessionKeyMode(uid);
      delete keyData[uid];
      keyDrawCache.invalidateKey(item.serialNumber, uid);
    }
  }

  syncRefreshLoops();
}

async function handleKeyInteraction(payload) {
  const { serialNumber, key } = extractInteractionKey(payload);
  if (!key || !DASHBOARD_CIDS.has(key.cid)) return;

  if (key.cid === SESSION_CID) {
    advanceSessionKeyMode(key.uid);
    drawDashboardKeys();
    // Snapshots taken while no AI Session key was loaded skip the scheduled tasks:
    // fetch them now instead of on the next tick (the key shows "loading" meanwhile).
    if (sessionKeyModes.get(key.uid) === SESSION_KEY_MODE.AUTOMATIONS && !hasAutomationData(latestSnapshot)) {
      refreshSnapshotInBackground();
    }
    return;
  }

  if (key.cid === TOKEN_USAGE_CID || key.cid === PLAN_USAGE_CID || key.cid === RESET_TIMER_CID) {
    usageCache = null;
    lastUsageAt = 0;
    refreshSnapshotInBackground();
    return;
  }

  if (key.cid === NEW_SESSION_CID) {
    const result = await openNewCodexSession(newSessionConfigFromKey(keyWithCachedDefaults(key)));
    if (!result.ok) logger.warn("Failed to open new Codex session:", result);
    notify(
      serialNumber,
      t(currentLanguage, newSessionMessageKey(result)),
      result.ok ? "success" : "error"
    );
    return;
  }

  if (key.cid === DOTS_CID) {
    await dotsKey.press(serialNumber, currentLanguage);
    return;
  }

  if (key.cid === SKILL_CID) {
    const actionKey = keyForAction(key);
    const result = await applySkillInvocation({
      skillName: skillNameFromKey(actionKey),
      platform: process.platform,
    });
    notify(serialNumber, skillActionMessage(result), result.ok ? "success" : "error");
  }
}

// Runs the 2s snapshot loop while a key needs AI data, otherwise only the slow
// redraw tick while any dashboard key is loaded, otherwise nothing.
function syncRefreshLoops() {
  dotsKey.setActive(hasKeysOfType("dots"));
  if (hasSnapshotKeys()) {
    startSnapshotLoop();
  } else if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }

  const needsRedrawLoop = !snapshotTimer && dashboardKeys.size > 0;
  if (needsRedrawLoop && !redrawTimer) {
    redrawTimer = setInterval(drawDashboardKeys, KEY_REDRAW_INTERVAL_MS);
  } else if (!needsRedrawLoop && redrawTimer) {
    clearInterval(redrawTimer);
    redrawTimer = null;
  }
}

function startSnapshotLoop() {
  if (snapshotTimer) return;

  refreshSnapshotInBackground();
  snapshotTimer = setInterval(refreshSnapshotInBackground, SESSION_INTERVAL_MS);
}

function refreshSnapshotInBackground() {
  return runInBackground("Refresh AI snapshot", refreshSnapshot);
}

function hasSnapshotKeys() {
  for (const item of dashboardKeys.values()) {
    if (item.type !== "newSession" && item.type !== "dots") return true;
  }
  return false;
}

function hasKeysOfType(type) {
  for (const item of dashboardKeys.values()) {
    if (item.type === type) return true;
  }
  return false;
}

// A snapshot taken with automations: false has no automations field at all; one that
// tried and failed still has one (available: false).
function hasAutomationData(snapshot) {
  return Boolean(snapshot && snapshot.automations);
}

// latestSnapshot stops updating once only New Codex Session keys remain.
function isFreshSnapshot(snapshot) {
  const collectedAt = Date.parse(snapshot && snapshot.collectedAt);
  return Number.isFinite(collectedAt) && Date.now() - collectedAt < 60_000;
}

async function collectRecentProjectsSnapshot() {
  try {
    return await collectAiSnapshot({
      codex: { ...collectorOptionsFromConfig(pluginConfig), appServerTimeoutMs: 2_500, includeUsage: false, includeQuota: false },
      automations: false,
    });
  } catch (error) {
    logger.warn("Failed to collect recent Codex projects:", error);
    return null;
  }
}

async function refreshSnapshot() {
  if (!hasSnapshotKeys()) {
    syncRefreshLoops();
    return;
  }
  if (snapshotInFlight) return;
  snapshotInFlight = true;

  try {
    // Collect with the host's path overrides when they are on their way. Keys
    // are already drawn ("loading" or the previous data), and this waits at
    // most until the sync deadline, without sending another getConfig().
    await waitForHostPluginConfigSync();
    const now = Date.now();
    const includeUsage = !usageCache || now - lastUsageAt >= USAGE_INTERVAL_MS;
    latestSnapshot = await collectAiSnapshot({
      codex: {
        ...collectorOptionsFromConfig(pluginConfig),
        appServerTimeoutMs: 2_500,
        includeUsage,
        includeQuota: includeUsage,
      },
      // Only AI Session keys show scheduled tasks; nobody else needs the app's database read.
      automations: hasKeysOfType("session"),
    });
    if (includeUsage) {
      usageCache = captureUsageCache(latestSnapshot);
      lastUsageAt = now;
    } else {
      applyUsageCache(latestSnapshot, usageCache);
    }
    logSnapshot(latestSnapshot, now);
  } catch (error) {
    hostLog.error("collectSnapshot", "Failed to collect AI snapshot:", error);
  } finally {
    snapshotInFlight = false;
    drawDashboardKeys();
  }
}

// Called from timers and host event handlers: must never throw. Unchanged keys
// are skipped by keyDrawCache, so calling it every refresh tick is cheap.
function drawDashboardKeys() {
  try {
    drawAllDashboardKeys();
  } catch (error) {
    hostLog.error("drawDashboardKeys", "Failed to draw dashboard keys:", error);
  }
}

function drawAllDashboardKeys() {
  if (!latestSnapshot) {
    for (const { serialNumber, key } of dashboardKeys.values()) {
      if (key.cid === SKILL_CID) {
        drawDefaultSkillKey(serialNumber, key);
      } else if (key.cid === NEW_SESSION_CID) {
        drawNewSessionKey(serialNumber, key);
      } else if (key.cid === DOTS_CID) {
        drawDotsKey(serialNumber, key);
      } else {
        drawLoadingKey(serialNumber, key);
      }
    }
    return;
  }

  const sessionItems = Array.from(dashboardKeys.values()).filter((item) => item.type === "session");
  const model = buildDashboardViewModel(latestSnapshot, dashboardState, {
    language: currentLanguage,
    sessionSlots: sessionItems.length,
  });

  // Built whenever a session key is loaded so finished sessions are tracked
  // even while no key shows the overview.
  const overview = sessionItems.length > 0
    ? buildSessionOverview(latestSnapshot, dashboardState, { language: currentLanguage })
    : null;

  let automations = null;
  let sessionIndex = 0;
  sessionItems.forEach((item) => {
    // Keys showing the overview or the scheduled tasks take no session slot.
    const mode = sessionKeyModes.get(item.key.uid);
    if (mode === SESSION_KEY_MODE.OVERVIEW) {
      drawSessionOverviewKey(item, overview);
      return;
    }
    if (mode === SESSION_KEY_MODE.AUTOMATIONS) {
      if (!hasAutomationData(latestSnapshot)) {
        // Not collected yet (not unavailable): see handleKeyInteraction.
        assignedSessionByKey.delete(item.key.uid);
        drawLoadingKey(item.serialNumber, item.key);
        return;
      }
      automations = automations || buildAutomationOverview(latestSnapshot, { language: currentLanguage });
      drawAutomationOverviewKey(item, automations);
      return;
    }
    const view = applySessionTitleMode(
      model.sessions[sessionIndex++] || emptySessionView(),
      sessionTitleModeFromKey(item.key)
    );
    if (view.sessionKey) {
      assignedSessionByKey.set(item.key.uid, view.sessionKey);
    } else {
      assignedSessionByKey.delete(item.key.uid);
    }
    drawImageKey(item.serialNumber, item.key, view, renderSessionKey, sessionFallbackTitle(view));
  });

  for (const item of dashboardKeys.values()) {
    if (item.type === "skill") {
      drawDefaultSkillKey(item.serialNumber, item.key);
      continue;
    }
    if (item.type === "newSession") {
      drawNewSessionKey(item.serialNumber, item.key);
      continue;
    }
    if (item.type === "dots") {
      drawDotsKey(item.serialNumber, item.key);
      continue;
    }

    if (item.type === "token") {
      drawImageKey(
        item.serialNumber,
        item.key,
        { ...model.totalTokens, mode: tokenDisplayModeFromKey(item.key) },
        renderTokenUsageKey,
        `${t(currentLanguage, "tokenUsageTitle")} ${model.totalTokens.label}`
      );
    } else if (item.type === "plan") {
      drawImageKey(item.serialNumber, item.key, model.planUsage, renderPlanUsageKey, `${t(currentLanguage, "planUsageTitle")} ${model.planUsage.label}`);
    } else if (item.type === "reset") {
      drawImageKey(item.serialNumber, item.key, model.resetTimer, renderResetTimerKey, t(currentLanguage, "resetTimerTitle"));
    }
  }
}

function drawDefaultSkillKey(serialNumber, key) {
  configureDefaultSkillKey(key, skillFallbackTitle(key));
  keyDrawCache.drawKey(serialNumber, key, "draw");
}

// One tap on an AI Session key: home -> overview -> automations -> home. Leaving
// home marks the key's own session viewed; leaving the overview marks the finished
// sessions it showed viewed (those hidden behind "+N" stay unread).
function advanceSessionKeyMode(uid) {
  const mode = sessionKeyModes.get(uid) || SESSION_KEY_MODE.HOME;
  if (mode === SESSION_KEY_MODE.HOME) {
    const sessionKey = assignedSessionByKey.get(uid);
    if (sessionKey) dashboardState.markViewed(sessionKey);
  } else if (mode === SESSION_KEY_MODE.OVERVIEW) {
    for (const sessionKey of overviewDoneSessionsByKey.get(uid) || []) {
      dashboardState.markViewed(sessionKey);
    }
    overviewDoneSessionsByKey.delete(uid);
  }

  const next = nextSessionKeyMode(mode);
  if (next === SESSION_KEY_MODE.HOME) {
    sessionKeyModes.delete(uid);
  } else {
    sessionKeyModes.set(uid, next);
  }
}

function forgetSessionKeyMode(uid) {
  sessionKeyModes.delete(uid);
  overviewDoneSessionsByKey.delete(uid);
}

function drawSessionOverviewKey(item, overview) {
  const view = applyOverviewTitleMode(overview || { items: [], runningCount: 0, doneCount: 0 }, sessionTitleModeFromKey(item.key));
  // Finished sessions hidden behind "+N" were never shown: they stay unread.
  const { visibleCount } = sessionOverviewLayout(keyWidth(item.key), view.items.length);
  overviewDoneSessionsByKey.set(
    item.key.uid,
    view.items.slice(0, visibleCount).filter((entry) => entry.status === "done").map((entry) => entry.sessionKey)
  );
  assignedSessionByKey.delete(item.key.uid);
  drawImageKey(item.serialNumber, item.key, view, renderSessionOverviewKey, sessionOverviewFallbackTitle(view));
}

function sessionOverviewFallbackTitle(view) {
  return `${view.runningCount} ${t(currentLanguage, "overviewRunning")} · ${view.doneCount} ${t(currentLanguage, "overviewDone")}`;
}

function drawAutomationOverviewKey(item, view) {
  assignedSessionByKey.delete(item.key.uid);
  drawImageKey(item.serialNumber, item.key, view, renderAutomationOverviewKey, automationOverviewFallbackTitle(view));
}

function automationOverviewFallbackTitle(view) {
  if (view.total === 0) {
    return t(currentLanguage, view.available ? "noScheduledTasks" : "scheduledTasksUnavailable");
  }
  return t(currentLanguage, view.total === 1 ? "scheduledTaskCountOne" : "scheduledTasksCount").replace("{n}", String(view.total));
}

function drawNewSessionKey(serialNumber, key) {
  const { projectPath } = newSessionConfigFromKey(key);
  drawImageKey(
    serialNumber,
    key,
    { project: projectLabel(projectPath) },
    renderNewSessionKey,
    t(currentLanguage, "newSessionTitle")
  );
}

function drawDotsKey(serialNumber, key) {
  const { view, fallbackTitle } = dotsKey.keyView(key, currentLanguage);
  drawImageKey(serialNumber, key, view, renderDotsKey, fallbackTitle);
}

function drawImageKey(serialNumber, key, view, renderer, fallbackTitle) {
  const style = ensureKeyStyle(key);
  style.showIcon = false;
  style.showTitle = false;

  let image;
  try {
    image = renderer(view, { width: keyWidth(key), language: currentLanguage });
  } catch (error) {
    hostLog.error("render", "Failed to render dashboard key image:", error);
    style.showTitle = true;
    key.title = fallbackTitle;
    keyDrawCache.drawKey(serialNumber, key, "draw");
    return;
  }
  keyDrawCache.drawKey(serialNumber, key, "base64", image);
}

function drawLoadingKey(serialNumber, key) {
  const style = ensureKeyStyle(key);
  style.showIcon = false;
  style.showTitle = true;
  key.title = t(currentLanguage, "loading");
  keyDrawCache.drawKey(serialNumber, key, "draw");
}

function ensureKeyStyle(key) {
  if (!key.style || typeof key.style !== "object") key.style = {};
  return key.style;
}

function callHost(label, call, level = "warn", timeoutMs = 0) {
  return safeCall(label, call, { log: hostLog, level, timeoutMs });
}

function runInBackground(label, task) {
  return safeCall(label, task, { log: hostLog, level: "error" });
}

function logSnapshot(snapshot, now) {
  const compact = compactSnapshot(snapshot);
  // collectedAt/elapsedMs change on every refresh; only log real changes plus
  // a periodic heartbeat instead of one line every 2 seconds.
  const serialized = JSON.stringify({ ...compact, collectedAt: undefined, elapsedMs: undefined });
  if (serialized === lastLoggedSnapshot && now - lastSnapshotLogAt < SNAPSHOT_LOG_HEARTBEAT_MS) return;
  lastLoggedSnapshot = serialized;
  lastSnapshotLogAt = now;
  logger.info("AI snapshot:", compact);
}

function dashboardKeyType(cid) {
  if (cid === SESSION_CID) return "session";
  if (cid === TOKEN_USAGE_CID) return "token";
  if (cid === PLAN_USAGE_CID) return "plan";
  if (cid === RESET_TIMER_CID) return "reset";
  if (cid === SKILL_CID) return "skill";
  if (cid === NEW_SESSION_CID) return "newSession";
  if (cid === DOTS_CID) return "dots";
  return "unknown";
}

function keyWidth(key) {
  return Math.max(60, Math.round(Number(
    key.width ||
    key.style && key.style.width ||
    key.data && key.data.width ||
    240
  )));
}

function emptySessionView() {
  return {
    title: t(currentLanguage, "noSession"),
    tokenLabel: t(currentLanguage, "unknown"),
    statusColor: "gray",
    activity: t(currentLanguage, "noActiveSessions"),
  };
}

function sessionFallbackTitle(view) {
  return `${view.title || "Session"} ${view.tokenLabel || ""}`.trim();
}

function skillFallbackTitle(key) {
  return skillNameFromKey(key) || t(currentLanguage, "selectSkill");
}

function skillActionMessage(result) {
  if (!result || !result.ok) return result && result.error || t(currentLanguage, "skillActionFailed");
  if (result.action === "copy") return t(currentLanguage, "promptCopied");
  return t(currentLanguage, "promptPasted");
}

function notify(serialNumber, rawMessage, level) {
  const message = snackbarText(rawMessage);
  if (serialNumber && typeof plugin.showFlexbarSnackbarMessage === "function") {
    callHost("Show Flexbar snackbar", () => plugin.showFlexbarSnackbarMessage(
      serialNumber,
      message,
      level,
      level === "error" ? "warning" : "ok",
      2500,
      false
    ));
    return;
  }
  if (typeof plugin.showSnackbarMessage === "function") {
    callHost("Show snackbar", () => plugin.showSnackbarMessage(level, message, 2500));
  }
}

function snackbarText(value) {
  // The host rejects snackbar messages whose UTF-16 length is 64 or more.
  const text = String(value || "").trim() || t(currentLanguage, "skillActionFailed");
  if (text.length <= SNACKBAR_MAX_LENGTH) return text;
  let result = "";
  for (const char of text) {
    if (result.length + char.length > SNACKBAR_MAX_LENGTH - 3) break;
    result += char;
  }
  return `${result}...`;
}

// Unlike keyForAction, the pressed key's own settings win; the cached
// plugin.alive copy only fills in what the tap payload leaves out.
function newSessionMessageKey(result) {
  if (result.ok) return "newSessionOpened";
  if (result.reason === "invalidProject") return "newSessionBadFolder";
  if (result.reason === "promptTooLong") return "newSessionPromptTooLong";
  return "newSessionFailed";
}

function keyWithCachedDefaults(key) {
  if (!key || key.uid === undefined || key.uid === null) return key;
  const cached = keyData[key.uid];
  if (!cached) return key;
  return {
    ...cached,
    ...key,
    data: {
      ...(cached.data || {}),
      ...(key.data || {}),
    },
    config: {
      ...(cached.config || {}),
      ...(key.config || {}),
    },
  };
}

function keyForAction(key) {
  if (!key || key.uid === undefined || key.uid === null) return key;
  const cached = keyData[key.uid];
  if (!cached || skillNameFromKey(key)) return key;
  return {
    ...key,
    ...cached,
    data: {
      ...(key.data || {}),
      ...(cached.data || {}),
    },
    config: {
      ...(key.config || {}),
      ...(cached.config || {}),
    },
  };
}

plugin.start();
