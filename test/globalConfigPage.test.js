"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const UI_DIR = path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin", "ui");

test("global config page persists through FlexDesigner setConfig", async () => {
  const component = loadVueComponent("global_config.vue");
  const saved = [];
  const setConfigCalls = [];
  const emitted = [];
  const { view } = mountConfigComponent(component, {
    modelValue: { config: {} },
    async sendToBackend(payload) {
      if (payload.type === "savePluginConfig") {
        saved.push(payload.config);
        return { ok: true, config: payload.config };
      }
      if (payload.type === "setupStatus") return { codex: {} };
      if (payload.type === "snapshot") return null;
      if (payload.type === "pathDefaults") return [];
      return {};
    },
    async setConfig(config) {
      setConfigCalls.push(config);
      return { status: "success" };
    },
    emit(event, value) {
      emitted.push({ event, value });
    },
  });

  view.pathFields = [
    {
      key: "CODEX_HOME",
      label: "Codex home",
      resolved: "/Users/test/.codex",
      description: "Overrides CODEX_HOME when set.",
    },
  ];
  view.applyPluginSettings({
    pathOverrides: { CODEX_HOME: "/custom/codex" },
  });
  await view.applyPathOverrides();

  assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0]), ["pathOverrides", "dotsStatusSource"]);
  assert.equal(saved[0].pathOverrides.CODEX_HOME, "/custom/codex");
  assert.equal(saved[0].dotsStatusSource, "auto");
  assert.equal(setConfigCalls.length, 1);
  assert.equal(setConfigCalls[0].pathOverrides.CODEX_HOME, "/custom/codex");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, "update:modelValue");
  assert.equal(emitted[0].value.config.pathOverrides.CODEX_HOME, "/custom/codex");
});

test("global config page surfaces backend path validation errors", async () => {
  const component = loadVueComponent("global_config.vue");
  const setConfigCalls = [];
  const { view } = mountConfigComponent(component, {
    async sendToBackend(payload) {
      if (payload.type === "savePluginConfig") {
        return {
          ok: false,
          errors: [{ key: "CODEX_HOME", message: "Codex home does not exist: /nope" }],
        };
      }
      return {};
    },
    async setConfig(config) {
      setConfigCalls.push(config);
    },
  });

  view.applyPluginSettings({
    pathOverrides: { CODEX_HOME: "/nope" },
  });
  await view.applyPathOverrides();

  assert.equal(view.pathValidationErrors.CODEX_HOME, "Codex home does not exist: /nope");
  assert.match(view.error, /Fix path override errors/);
  assert.equal(setConfigCalls.length, 0);
});

test("global config page prefers hosted modelValue.config over backend defaults", async () => {
  const component = loadVueComponent("global_config.vue");
  const { view } = mountConfigComponent(component, {
    modelValue: {
      config: {
        pathOverrides: { CODEX_HOME: "/hosted/codex" },
      },
    },
    async sendToBackend(payload) {
      if (payload.type === "getPluginConfig") {
        return {
          pathOverrides: { CODEX_HOME: "/backend/codex" },
        };
      }
      return {};
    },
  });

  await view.loadInitialSettings();

  assert.equal(view.pluginSettings.pathOverrides.CODEX_HOME, "/hosted/codex");
});

test("global config page reports Codex status only and ignores settings older versions saved", async () => {
  const component = loadVueComponent("global_config.vue");
  const requested = [];
  const { view } = mountConfigComponent(component, {
    modelValue: { config: { overwriteStatusLine: true, pathOverrides: {} } },
    async sendToBackend(payload) {
      requested.push(payload.type);
      if (payload.type === "getPluginConfig") return { pathOverrides: { CODEX_HOME: "/backend/codex" } };
      if (payload.type === "setupStatus") {
        return { codex: { codexHome: "/Users/me/.codex", codexHomeExists: true, authJsonExists: true, sessionsDir: "/Users/me/.codex/sessions", sessionsDirExists: true } };
      }
      if (payload.type === "pathDefaults") return [];
      return null;
    },
  });

  // A hosted config that only holds a removed setting falls back to the backend copy.
  await view.loadInitialSettings();
  assert.equal(view.pluginSettings.pathOverrides.CODEX_HOME, "/backend/codex");
  assert.deepEqual(Object.keys(view.buildConfigPayload()), ["pathOverrides", "dotsStatusSource"]);

  await view.refresh();
  assert.deepEqual(Array.from(view.statusItems, (item) => item.label), ["Codex home", "Codex auth", "Codex sessions"]);
  assert.equal(view.overallReady, true);
  assert.deepEqual(requested.sort(), ["getPluginConfig", "pathDefaults", "setupStatus", "snapshot"]);
});

test("global config page ignores Claude path overrides older versions saved", async () => {
  const component = loadVueComponent("global_config.vue");
  const legacyOverrides = {
    CLAUDE_CONFIG_DIR: "/Users/me/.claude",
    FLEXBAR_AI_CLAUDE_EVENTS: "/Users/me/.flexbar-ai-dashboard/events.jsonl",
  };
  const requested = [];
  const backend = async (payload) => {
    requested.push(payload.type);
    if (payload.type === "getPluginConfig") return { pathOverrides: { CODEX_HOME: "/Users/me/custom-codex" } };
    return {};
  };

  // A hosted config whose only overrides are removed ones falls back to the backend copy.
  const fallback = mountConfigComponent(component, {
    modelValue: { config: { pathOverrides: { CODEX_HOME: "", ...legacyOverrides } } },
    sendToBackend: backend,
  }).view;
  await fallback.loadInitialSettings();
  assert.deepEqual(requested, ["getPluginConfig"]);
  assert.deepEqual(plain(fallback.pluginSettings), { pathOverrides: { CODEX_HOME: "/Users/me/custom-codex" }, dotsStatusSource: "auto" });
  assert.deepEqual(plain(fallback.savedPluginSettings), plain(fallback.pluginSettings));

  // A hosted Codex override is used as is, without the removed keys.
  requested.length = 0;
  const hosted = mountConfigComponent(component, {
    modelValue: { config: { pathOverrides: { CODEX_HOME: "/hosted/codex", ...legacyOverrides } } },
    sendToBackend: backend,
  }).view;
  await hosted.loadInitialSettings();
  assert.deepEqual(requested, []);
  assert.deepEqual(plain(hosted.buildConfigPayload()), { pathOverrides: { CODEX_HOME: "/hosted/codex" }, dotsStatusSource: "auto" });

  // Typing the saved value back leaves nothing to apply.
  hosted.pathFields = [{ key: "CODEX_HOME", label: "Codex home", resolved: "/Users/me/.codex", description: "" }];
  hosted.updatePathOverride("CODEX_HOME", "/elsewhere");
  assert.equal(hosted.pathOverridesDirty, true);
  hosted.updatePathOverride("CODEX_HOME", "/hosted/codex");
  assert.equal(hosted.pathOverridesDirty, false);
});

test("global config page saves the Dots status source at once, keeping unsaved path edits", async () => {
  const component = loadVueComponent("global_config.vue");
  const saved = [];
  const setConfigCalls = [];
  const { view } = mountConfigComponent(component, {
    async sendToBackend(payload) {
      if (payload.type === "savePluginConfig") {
        saved.push(payload.config);
        return { ok: true, config: payload.config };
      }
      return {};
    },
    async setConfig(config) {
      setConfigCalls.push(config);
    },
  });
  view.pathFields = [{ key: "CODEX_HOME", label: "Codex home", resolved: "/Users/me/.codex", description: "" }];
  view.applyPluginSettings({ pathOverrides: { CODEX_HOME: "/saved/codex" }, dotsStatusSource: "auto" });
  view.updatePathOverride("CODEX_HOME", "/unsaved/codex");
  assert.equal(view.dotsStatusSource, "auto");

  await view.updateDotsStatusSource("local");

  assert.deepEqual(plain(saved), [{ pathOverrides: { CODEX_HOME: "/saved/codex" }, dotsStatusSource: "local" }]);
  assert.deepEqual(plain(setConfigCalls), plain(saved));
  assert.equal(view.dotsStatusSource, "local");
  assert.equal(view.savedPluginSettings.dotsStatusSource, "local");
  assert.equal(view.pluginSettings.pathOverrides.CODEX_HOME, "/unsaved/codex", "the path edit is still pending");
  assert.equal(view.pathOverridesDirty, true);
  assert.match(view.dotsSaveMessage, /saved/i);

  // Choosing the saved value again, or something unknown that normalizes to it, sends nothing.
  await view.updateDotsStatusSource("local");
  await view.updateDotsStatusSource("bogus");
  assert.equal(saved.length, 2);
  assert.equal(saved[1].dotsStatusSource, "auto");
});

test("global config page reverts the Dots status source when saving fails", async () => {
  const component = loadVueComponent("global_config.vue");
  const { view } = mountConfigComponent(component, {
    async sendToBackend(payload) {
      if (payload.type === "savePluginConfig") return { ok: false, error: "host did not answer" };
      return {};
    },
  });
  view.applyPluginSettings({ pathOverrides: { CODEX_HOME: "" }, dotsStatusSource: "auto" });
  await view.updateDotsStatusSource("local");
  assert.equal(view.dotsStatusSource, "auto");
  assert.match(view.error, /host did not answer/);
});

test("a hosted config that only chose local Dots status is used as is", async () => {
  const component = loadVueComponent("global_config.vue");
  const requested = [];
  const { view } = mountConfigComponent(component, {
    modelValue: { config: { pathOverrides: { CODEX_HOME: "" }, dotsStatusSource: "local" } },
    async sendToBackend(payload) {
      requested.push(payload.type);
      return { pathOverrides: { CODEX_HOME: "" }, dotsStatusSource: "auto" };
    },
  });
  await view.loadInitialSettings();
  assert.deepEqual(requested, []);
  assert.equal(view.dotsStatusSource, "local");
});

test("global config page explains the Dots status choices", () => {
  const content = fs.readFileSync(path.join(UI_DIR, "global_config.vue"), "utf8");
  assert.match(content, /value="auto"/);
  assert.match(content, /value="local"/);
  assert.match(content, /read-only/i);
  assert.match(content, /never refreshes/i);
  // The app's cache has no room preview: in local mode the key cannot tell that a dot has something new.
  assert.match(content, /cannot show <strong>Update<\/strong>/);
});

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadVueComponent(fileName) {
  const content = fs.readFileSync(path.join(UI_DIR, fileName), "utf8");
  const match = content.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, `${fileName} has a script block`);

  const sandbox = {
    component: null,
    console,
    document: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(match[1].replace(/\bexport\s+default\b/, "component ="), sandbox, {
    filename: fileName,
  });
  return sandbox.component;
}

function mountConfigComponent(component, options = {}) {
  const emitted = [];
  const view = {
    modelValue: options.modelValue || { config: {} },
    pathFields: [],
    pluginSettings: {
      pathOverrides: {},
    },
    savedPluginSettings: {
      pathOverrides: {},
    },
    settingsLoaded: false,
    $fd: {
      sendToBackend: options.sendToBackend || (async () => ({})),
      setConfig: options.setConfig || (async () => ({ status: "success" })),
    },
    $emit(event, value) {
      if (options.emit) {
        options.emit(event, value);
        return;
      }
      emitted.push({ event, value });
    },
  };

  for (const [name, method] of Object.entries(component.methods || {})) {
    view[name] = method.bind(view);
  }

  for (const [name, descriptor] of Object.entries(component.computed || {})) {
    const get = typeof descriptor === "function" ? descriptor : descriptor.get;
    Object.defineProperty(view, name, {
      enumerable: true,
      get: get ? get.bind(view) : undefined,
      set: descriptor.set ? descriptor.set.bind(view) : undefined,
    });
  }

  return { view, emitted };
}
