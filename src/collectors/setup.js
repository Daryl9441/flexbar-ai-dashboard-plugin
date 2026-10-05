"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveCodexHome } = require("./paths");

// The local Codex data the settings page reports: its home, the auth.json whose
// OAuth token reads plan usage, and the session logs.
function getSetupStatus(options = {}) {
  const codexHome = options.codexHome || resolveCodexHome(options.env || process.env);
  const authJsonPath = path.join(codexHome, "auth.json");
  const sessionsDir = path.join(codexHome, "sessions");

  return {
    codex: {
      codexHome,
      codexHomeExists: exists(codexHome),
      authJsonPath,
      authJsonExists: exists(authJsonPath),
      sessionsDir,
      sessionsDirExists: exists(sessionsDir),
    },
  };
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getSetupStatus,
};
