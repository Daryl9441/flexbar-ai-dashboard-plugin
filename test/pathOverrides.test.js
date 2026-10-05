"use strict";

const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { getSetupStatus } = require("../src/collectors/setup");
const { expandUserPath } = require("../src/collectors/pathOverrideValidation");
const {
  collectorOptionsFromConfig,
  envWithPathOverrides,
  listPathDefaults,
  normalizePluginConfig,
} = require("../src/collectors/pathOverrides");

test("path overrides apply CODEX_HOME to collector env", () => {
  const customCodex = path.join(os.tmpdir(), "custom-codex-home");
  const env = envWithPathOverrides({
    pathOverrides: {
      CODEX_HOME: customCodex,
    },
  });

  assert.equal(env.CODEX_HOME, customCodex);
});

test("a CODEX_HOME override under ~ reaches the collectors expanded, as validation reads it", () => {
  const env = { HOME: "/Users/me" };
  for (const value of ["~/.codex", " ~/.codex "]) {
    assert.equal(envWithPathOverrides({ pathOverrides: { CODEX_HOME: value } }, env).CODEX_HOME, path.join("/Users/me", ".codex"));
  }
  assert.equal(envWithPathOverrides({ pathOverrides: { CODEX_HOME: "~" } }, env).CODEX_HOME, "/Users/me");
  assert.equal(collectorOptionsFromConfig({ pathOverrides: { CODEX_HOME: "~/.codex" } }, { env }).codexHome, path.join("/Users/me", ".codex"));

  // With the plugin's own environment both sides resolve the same absolute directory.
  const codexHome = collectorOptionsFromConfig({ pathOverrides: { CODEX_HOME: "~/.codex" } }).codexHome;
  assert.equal(codexHome, expandUserPath("~/.codex"));
  assert.ok(path.isAbsolute(codexHome));
  assert.equal(getSetupStatus(collectorOptionsFromConfig({ pathOverrides: { CODEX_HOME: "~/.codex" } })).codex.codexHome, codexHome);
});

test("collector options expose resolved paths from plugin config", () => {
  const customCodex = path.join(os.tmpdir(), "custom-codex");
  const options = collectorOptionsFromConfig({
    pathOverrides: {
      CODEX_HOME: customCodex,
    },
  });

  assert.equal(options.codexHome, customCodex);
});

test("setup status honors codex home override from plugin config", () => {
  const customHome = path.join(os.tmpdir(), "flexbar-path-override-home");
  const status = getSetupStatus(collectorOptionsFromConfig({
    pathOverrides: {
      CODEX_HOME: path.join(customHome, "codex"),
    },
  }));

  assert.equal(status.codex.codexHome, path.join(customHome, "codex"));
});

test("path defaults describe auto-detected resolved values", () => {
  const defaults = listPathDefaults({
    HOME: "/tmp/flexbar-home",
    USERPROFILE: "/tmp/flexbar-home",
    CODEX_HOME: "/tmp/flexbar-codex",
  });

  assert.deepEqual(defaults.map((item) => item.key), ["CODEX_HOME"]);
  assert.equal(defaults[0].resolved, "/tmp/flexbar-codex");
});

test("normalizePluginConfig fills missing override keys", () => {
  assert.deepEqual(normalizePluginConfig({}), { pathOverrides: { CODEX_HOME: "" } });
  assert.deepEqual(normalizePluginConfig({ pathOverrides: { CODEX_HOME: "/tmp/codex" } }), {
    pathOverrides: { CODEX_HOME: "/tmp/codex" },
  });
});

test("normalizePluginConfig silently drops settings saved by older versions", () => {
  // Older versions also watched Claude Code and saved these settings.
  const legacy = {
    overwriteStatusLine: true,
    pathOverrides: {
      CODEX_HOME: "/tmp/codex",
      CLAUDE_CONFIG_DIR: "/tmp/claude-config",
      FLEXBAR_AI_CLAUDE_EVENTS: "/tmp/flexbar-ai-dashboard/claude-events.jsonl",
    },
  };
  const expected = { pathOverrides: { CODEX_HOME: "/tmp/codex" } };

  assert.deepEqual(normalizePluginConfig(legacy), expected);
  assert.deepEqual(normalizePluginConfig({ uuid: "com.aspen.flexbar-ai-dashboard", config: legacy }), expected);
  assert.deepEqual(normalizePluginConfig({ overwriteStatusLine: false }), { pathOverrides: { CODEX_HOME: "" } });

  const env = envWithPathOverrides(legacy, { HOME: "/tmp/flexbar-home" });
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal("CLAUDE_CONFIG_DIR" in env, false);
  assert.equal("FLEXBAR_AI_CLAUDE_EVENTS" in env, false);
});
