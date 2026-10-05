"use strict";

const os = require("node:os");
const path = require("node:path");

function resolveHome(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function resolveCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(resolveHome(env), ".codex");
}

// A path typed on the settings page: a leading "~" is the user's home, and the result
// is absolute. Validation and the collectors both resolve overrides through this, so
// they always look at the same directory.
function expandUserPath(rawValue, env = process.env) {
  const trimmed = String(rawValue).trim();
  const home = resolveHome(env);

  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return path.join(home, trimmed.slice(2));
  if (trimmed.startsWith("~")) return path.join(home, trimmed.slice(1));

  return path.resolve(trimmed);
}

module.exports = {
  expandUserPath,
  resolveCodexHome,
  resolveHome,
};
