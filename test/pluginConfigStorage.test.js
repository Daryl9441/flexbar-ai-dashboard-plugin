"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { getSetupStatus } = require("../src/collectors/setup");
const { collectorOptionsFromConfig } = require("../src/collectors/pathOverrides");
const {
  loadPluginConfigState,
  mergePluginConfigs,
  readPluginConfigFile,
  writePluginConfigFile,
} = require("../src/collectors/pluginConfigStorage");

test("plugin config file round-trips path overrides", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-plugin-config-"));
  const codexHome = path.join(tempDir, "codex");

  fs.mkdirSync(codexHome, { recursive: true });
  writePluginConfigFile(tempDir, {
    pathOverrides: { CODEX_HOME: codexHome },
  });

  const loaded = readPluginConfigFile(tempDir);
  assert.equal(loaded.pathOverrides.CODEX_HOME, codexHome);
});

test("loadPluginConfigState reads config before collector setup uses overrides", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-plugin-load-"));
  const codexHome = path.join(tempDir, "codex");
  fs.mkdirSync(codexHome, { recursive: true });

  writePluginConfigFile(tempDir, {
    pathOverrides: { CODEX_HOME: codexHome },
  });

  const { config } = loadPluginConfigState(tempDir);
  const status = getSetupStatus(collectorOptionsFromConfig(config));

  assert.equal(status.codex.codexHome, codexHome);
});

test("mergePluginConfigs keeps disk overrides when host config is empty", () => {
  const merged = mergePluginConfigs(
    { pathOverrides: { CODEX_HOME: "/disk/codex" } },
    { pathOverrides: { CODEX_HOME: "" } }
  );

  assert.equal(merged.pathOverrides.CODEX_HOME, "/disk/codex");
});

test("mergePluginConfigs applies non-empty host overrides on top of disk config", () => {
  const merged = mergePluginConfigs(
    { pathOverrides: { CODEX_HOME: "/disk/codex" } },
    { pathOverrides: { CODEX_HOME: "/host/codex" } }
  );

  assert.equal(merged.pathOverrides.CODEX_HOME, "/host/codex");
});

test("a config.json saved by an older version loads without its removed settings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-plugin-legacy-"));
  const codexHome = path.join(tempDir, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  // Written as-is (not through writePluginConfigFile), like an older version did.
  fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({
    overwriteStatusLine: true,
    pathOverrides: {
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: path.join(tempDir, "claude-config"),
      FLEXBAR_AI_CLAUDE_EVENTS: path.join(tempDir, "events.jsonl"),
    },
  }), "utf8");

  const { config, warning } = loadPluginConfigState(tempDir);
  assert.equal(warning, null);
  assert.deepEqual(config, { dotsStatusSource: "auto", pathOverrides: { CODEX_HOME: codexHome } });
  assert.equal(getSetupStatus(collectorOptionsFromConfig(config)).codex.codexHome, codexHome);

  // The host may still push the old settings; merging drops them too.
  const merged = mergePluginConfigs(config, { config: { overwriteStatusLine: false, pathOverrides: { CLAUDE_CONFIG_DIR: "/x" } } });
  assert.deepEqual(merged, { dotsStatusSource: "auto", pathOverrides: { CODEX_HOME: codexHome } });

  writePluginConfigFile(tempDir, merged);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf8")), merged);
});

test("the Dots status source round-trips and survives a host config that predates it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-plugin-dots-"));
  writePluginConfigFile(tempDir, { pathOverrides: { CODEX_HOME: "" }, dotsStatusSource: "local" });
  const { config } = loadPluginConfigState(tempDir);
  assert.equal(config.dotsStatusSource, "local");

  // An older host copy without the setting keeps the saved choice; a newer one changes it.
  assert.equal(mergePluginConfigs(config, { pathOverrides: { CODEX_HOME: "" } }).dotsStatusSource, "local");
  assert.equal(mergePluginConfigs(config, { config: { dotsStatusSource: "auto" } }).dotsStatusSource, "auto");
  assert.equal(mergePluginConfigs(config, { dotsStatusSource: "bogus" }).dotsStatusSource, "local");
  assert.equal(mergePluginConfigs({}, {}).dotsStatusSource, "auto");
});
