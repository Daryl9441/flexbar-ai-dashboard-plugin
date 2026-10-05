"use strict";

const { languageFromPayload } = require("./i18n");

function extractLoadedKeys(payload) {
  const serialNumber = payload && payload.serialNumber || null;
  const keys = firstArray(
    payload && payload.keys,
    payload && payload.page && payload.page.keys,
    payload && payload.data && payload.data.keys,
    payload && payload.data && payload.data.page && payload.data.page.keys
  );

  return {
    serialNumber,
    keys,
  };
}

function extractInteractionKey(payload) {
  return {
    serialNumber: payload && payload.serialNumber || null,
    key: payload && (
      payload.key ||
      payload.data && payload.data.key ||
      payload.userData && payload.userData.key ||
      payload.data && payload.data.userData && payload.data.userData.key
    ) || null,
  };
}

/**
 * Normalizes `device.status` payloads. FlexDesigner sends an array such as
 * [{ serialNumber, status: "connected", deviceData }] or
 * [{ serialNumber, status: "disconnected", _removeDevice: true }].
 * Returns [{ serialNumber, status: "connected" | "disconnected" }] and drops
 * entries with an unknown status or no serial number.
 */
function extractDeviceStatuses(payload) {
  let items = Array.isArray(payload)
    ? payload
    : firstArray(payload && payload.devices, payload && payload.data && payload.data.devices);
  if (!Array.isArray(payload) && items.length === 0 && payload && typeof payload === "object") {
    items = [payload];
  }

  const statuses = [];
  for (const item of items) {
    const serialNumber = item && typeof item === "object" ? item.serialNumber : null;
    const status = deviceConnectionStatus(item);
    if (serialNumber && status) statuses.push({ serialNumber, status });
  }
  return statuses;
}

function deviceConnectionStatus(item) {
  if (!item || typeof item !== "object") return null;
  if (item._removeDevice === true) return "disconnected";
  const status = String(item.status || "").toLowerCase();
  if (status === "connected" || status === "disconnected") return status;
  return null;
}

function sessionTitleModeFromKey(key) {
  const data = keyConfigFromKey(key);
  const value = data.sessionTitleMode || data.titleMode;
  return value === "latest" ? "latest" : "initial";
}

function tokenDisplayModeFromKey(key) {
  const data = keyConfigFromKey(key);
  return data.tokenDisplayMode === "recentChart" ? "recentChart" : "summary";
}

function dataSourceFromKey(key) {
  const data = keyConfigFromKey(key);
  return data.dataSource === "claude" ? "claude" : "codex";
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function keyConfigFromKey(key) {
  const data = key && key.data && typeof key.data === "object" && !Array.isArray(key.data)
    ? key.data
    : {};
  const nestedConfig = data.config && typeof data.config === "object" && !Array.isArray(data.config)
    ? data.config
    : {};
  const config = key && key.config && typeof key.config === "object" && !Array.isArray(key.config)
    ? key.config
    : {};
  const rootConfig = rootConfigFromKey(key);
  return {
    ...data,
    ...rootConfig,
    ...nestedConfig,
    ...config,
  };
}

function rootConfigFromKey(key) {
  if (!key || typeof key !== "object" || Array.isArray(key)) return {};

  const config = {};
  for (const name of ["dataSource", "sessionTitleMode", "titleMode", "tokenDisplayMode"]) {
    if (Object.prototype.hasOwnProperty.call(key, name)) {
      config[name] = key[name];
    }
  }
  return config;
}

module.exports = {
  dataSourceFromKey,
  extractDeviceStatuses,
  extractInteractionKey,
  extractLoadedKeys,
  languageFromPayload,
  sessionTitleModeFromKey,
  tokenDisplayModeFromKey,
};
