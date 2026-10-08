"use strict";

const { expandUserPath, resolveCodexHome } = require("./paths");

/** @type {ReadonlyArray<{ key: string, label: string, description: string, placeholder: (env: NodeJS.ProcessEnv) => string }>} */
// Where the ChatGPT Dots key reads its status: "auto" asks chatgpt.com (read-only) and falls back to the app's local
// cache; "local" reads only that cache and never touches the network.
const DOTS_STATUS_SOURCES = Object.freeze(["auto", "local"]);
const DEFAULT_DOTS_STATUS_SOURCE = "auto";

const PATH_OVERRIDE_DEFINITIONS = [
  {
    key: "CODEX_HOME",
    label: "Codex home",
    description: "Overrides CODEX_HOME when set.",
    placeholder: (env) => resolveCodexHome(env),
  },
];

function unwrapPluginConfigPayload(payload) {
  if (!payload || typeof payload !== "object") return {};

  if (!("pathOverrides" in payload) && payload.config && typeof payload.config === "object") {
    return payload.config;
  }

  return payload;
}

function readPathOverrides(config) {
  const root = unwrapPluginConfigPayload(config);
  const overrides = root.pathOverrides && typeof root.pathOverrides === "object"
    ? root.pathOverrides
    : {};
  return overrides;
}

function normalizePluginConfig(config) {
  const root = unwrapPluginConfigPayload(config);
  const overrides = readPathOverrides(root);
  const normalizedOverrides = {};

  for (const definition of PATH_OVERRIDE_DEFINITIONS) {
    const value = overrides[definition.key];
    normalizedOverrides[definition.key] = typeof value === "string" ? value : "";
  }

  // Settings older versions saved that no longer exist are dropped, like path
  // overrides without a definition above, so such a config still loads.
  const {
    pathOverrides: _ignored,
    HOME: _legacyHome,
    overwriteStatusLine: _legacyStatusLine,
    ...rest
  } = root;

  return {
    ...rest,
    dotsStatusSource: normalizeDotsStatusSource(root.dotsStatusSource),
    pathOverrides: normalizedOverrides,
  };
}

function normalizeDotsStatusSource(value) {
  return DOTS_STATUS_SOURCES.includes(value) ? value : DEFAULT_DOTS_STATUS_SOURCE;
}

function envWithPathOverrides(config, baseEnv = process.env) {
  const overrides = readPathOverrides(normalizePluginConfig(config));
  const env = { ...baseEnv };

  for (const definition of PATH_OVERRIDE_DEFINITIONS) {
    const value = overrides[definition.key];
    if (typeof value !== "string" || !value.trim()) continue;

    // Expanded as validation expands it: "~/.codex" passes validation, and the
    // collectors must not read it relative to the plugin's working directory.
    env[definition.key] = expandUserPath(value, baseEnv);
  }

  return env;
}

function collectorOptionsFromConfig(config, extra = {}) {
  const env = envWithPathOverrides(config, extra.env || process.env);

  return {
    ...extra,
    env,
    codexHome: resolveCodexHome(env),
  };
}

function listPathDefaults(baseEnv = process.env) {
  return PATH_OVERRIDE_DEFINITIONS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    description: definition.description,
    resolved: definition.placeholder(baseEnv),
  }));
}

module.exports = {
  DOTS_STATUS_SOURCES,
  PATH_OVERRIDE_DEFINITIONS,
  collectorOptionsFromConfig,
  envWithPathOverrides,
  listPathDefaults,
  normalizeDotsStatusSource,
  normalizePluginConfig,
  readPathOverrides,
  unwrapPluginConfigPayload,
};
