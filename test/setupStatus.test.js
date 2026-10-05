"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { getSetupStatus } = require("../src/collectors/setup");

test("setup status reports Codex home, auth.json and sessions directory", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-ai-setup-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const env = { HOME: tempDir, USERPROFILE: tempDir };
  const codexHome = path.join(tempDir, ".codex");

  assert.deepEqual(getSetupStatus({ env }), {
    codex: {
      codexHome,
      codexHomeExists: false,
      authJsonPath: path.join(codexHome, "auth.json"),
      authJsonExists: false,
      sessionsDir: path.join(codexHome, "sessions"),
      sessionsDirExists: false,
    },
  });
  assert.deepEqual(fs.readdirSync(tempDir), [], "reading the status creates nothing");

  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}", "utf8");
  const { codex } = getSetupStatus({ env });

  assert.equal(codex.codexHomeExists, true);
  assert.equal(codex.authJsonExists, true);
  assert.equal(codex.sessionsDirExists, true);
});
