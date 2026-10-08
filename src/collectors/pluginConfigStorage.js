"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DOTS_STATUS_SOURCES,
  normalizePluginConfig,
  readPathOverrides,
  unwrapPluginConfigPayload,
} = require("./pathOverrides");

function pluginConfigPath(pluginDirectory) {
  if (!pluginDirectory) return null;
  return path.join(pluginDirectory, "config.json");
}

function readPluginConfigFile(pluginDirectory) {
  const configPath = pluginConfigPath(pluginDirectory);
  if (!configPath || !fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return normalizePluginConfig(raw);
  } catch (error) {
    return {
      error: error && error.message ? error.message : String(error),
      path: configPath,
    };
  }
}

function writePluginConfigFile(pluginDirectory, config) {
  const configPath = pluginConfigPath(pluginDirectory);
  if (!configPath) return false;

  const normalized = normalizePluginConfig(config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return true;
}

function mergePluginConfigs(baseConfig, nextConfig) {
  const baseOverrides = readPathOverrides(normalizePluginConfig(baseConfig));
  const nextOverrides = readPathOverrides(normalizePluginConfig(nextConfig));
  const pathOverrides = { ...baseOverrides };

  for (const [key, value] of Object.entries(nextOverrides)) {
    if (typeof value === "string" && value.trim()) {
      pathOverrides[key] = value.trim();
    }
  }

  // A host copy saved before the Dots setting existed keeps the current choice.
  const nextSource = unwrapPluginConfigPayload(nextConfig).dotsStatusSource;
  const dotsStatusSource = DOTS_STATUS_SOURCES.includes(nextSource)
    ? nextSource
    : normalizePluginConfig(baseConfig).dotsStatusSource;

  return normalizePluginConfig({ pathOverrides, dotsStatusSource });
}

function loadPluginConfigState(pluginDirectory) {
  const fromDisk = readPluginConfigFile(pluginDirectory);
  if (fromDisk && fromDisk.error) {
    return {
      config: normalizePluginConfig({}),
      warning: `Failed to read plugin config file: ${fromDisk.error}`,
    };
  }

  return {
    config: normalizePluginConfig(fromDisk || {}),
    warning: null,
  };
}

module.exports = {
  loadPluginConfigState,
  mergePluginConfigs,
  pluginConfigPath,
  readPluginConfigFile,
  writePluginConfigFile,
};
