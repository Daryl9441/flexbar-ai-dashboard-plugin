"use strict";

const fs = require("node:fs");
const { PATH_OVERRIDE_DEFINITIONS, readPathOverrides } = require("./pathOverrides");
const { expandUserPath } = require("./paths");

/**
 * Validate non-empty path override values before persisting plugin config.
 *
 * :param config: Plugin config object (normalized or raw).
 * :returns: ``{ ok: true }`` or ``{ ok: false, errors: Array<{ key, message }> }``.
 */
function validatePathOverrides(config) {
  const overrides = readPathOverrides(config);
  const errors = [];

  for (const definition of PATH_OVERRIDE_DEFINITIONS) {
    const rawValue = overrides[definition.key];
    if (typeof rawValue !== "string" || !rawValue.trim()) continue;

    const fieldErrors = validateOverrideValue(definition.key, rawValue.trim());
    errors.push(...fieldErrors);
  }

  if (errors.length === 0) {
    return { ok: true };
  }

  return { ok: false, errors };
}

/**
 * @param {string} key
 * @param {string} rawValue
 * @returns {Array<{ key: string, message: string }>}
 */
function validateOverrideValue(key, rawValue) {
  switch (key) {
    case "CODEX_HOME":
      return validateCodexHome(rawValue);
    default:
      return [];
  }
}

function validateCodexHome(rawValue) {
  const resolved = expandUserPath(rawValue);
  const stat = statPath(resolved);

  if (!stat) {
    return [error("CODEX_HOME", `Codex home does not exist: ${resolved}`)];
  }
  if (!stat.isDirectory()) {
    return [error("CODEX_HOME", `Codex home must be a directory: ${resolved}`)];
  }

  return [];
}

function statPath(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function error(key, message) {
  return { key, message };
}

module.exports = {
  expandUserPath,
  validateOverrideValue,
  validatePathOverrides,
};
