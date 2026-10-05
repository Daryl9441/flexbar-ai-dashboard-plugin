"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { ICON_BADGES, OPENAI_LOGO_PATH } = require("../src/dashboard/openaiLogo");

const UI_DIR = path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin", "ui");

// Every config page -> the badge of its key's key-library icon (null: the plugin's own icon).
const PAGE_BADGES = {
  "session.vue": "session",
  "token-usage.vue": "token",
  "plan-usage.vue": "plan",
  "reset-timer.vue": "reset",
  "new-session.vue": "newSession",
  "skill.vue": "skill",
  "global_config.vue": null,
};
// The mdi icons the page headers showed before the OpenAI mark.
const OLD_HEADER_ICONS = [
  "mdi-robot",
  "mdi-counter",
  "mdi-chart-bar",
  "mdi-timer-sand",
  "mdi-message-plus-outline",
  "mdi-star-four-points",
  "mdi-view-dashboard-outline",
];

test("session config page writes title mode into full key data model", () => {
  const component = loadVueComponent("session.vue");
  const { view, emitted } = mountConfigComponent(component, {
    cid: "com.aspen.flexbar-ai-dashboard.session",
    title: "AI Session",
    style: {},
    data: {
      sessionTitleMode: "initial",
    },
  });

  view.titleMode = "latest";

  const next = latestModel(emitted);
  assert.equal(next.data.sessionTitleMode, "latest");
  assert.equal(next.sessionTitleMode, undefined);
});

test("session config page migrates stale top-level title mode from older saves", () => {
  const component = loadVueComponent("session.vue");
  const { view, emitted } = mountConfigComponent(component, {
    cid: "com.aspen.flexbar-ai-dashboard.session",
    title: "AI Session",
    sessionTitleMode: "latest",
    data: {
      sessionTitleMode: "initial",
    },
  });

  assert.equal(view.titleMode, "latest");

  view.titleMode = "latest";

  const next = latestModel(emitted);
  assert.equal(next.data.sessionTitleMode, "latest");
  assert.equal(next.sessionTitleMode, undefined);
});

test("token usage config page writes display mode into full key data model", () => {
  const component = loadVueComponent("token-usage.vue");
  const { view, emitted } = mountConfigComponent(component, {
    cid: "com.aspen.flexbar-ai-dashboard.token-usage",
    title: "Token Usage",
    style: {},
    data: {
      tokenDisplayMode: "summary",
    },
  });

  view.displayMode = "recentChart";

  const next = latestModel(emitted);
  assert.equal(next.data.tokenDisplayMode, "recentChart");
  assert.equal(next.tokenDisplayMode, undefined);
});

test("every config page header shows the OpenAI mark, with its key's badge color, instead of an mdi icon", () => {
  assert.deepEqual(
    fs.readdirSync(UI_DIR).filter((name) => name.endsWith(".vue")).sort(),
    Object.keys(PAGE_BADGES).sort(),
    "a page is missing from PAGE_BADGES"
  );
  for (const [fileName, badge] of Object.entries(PAGE_BADGES)) {
    const content = fs.readFileSync(path.join(UI_DIR, fileName), "utf8");
    const header = content.match(/<v-card-item\b([^>]*)>([\s\S]*?)<\/v-card-item>/);
    assert.ok(header, `${fileName} has a v-card-item header`);
    const [, attributes, body] = header;

    assert.doesNotMatch(attributes, /prepend-icon/, fileName);
    for (const icon of OLD_HEADER_ICONS) assert.ok(!content.includes(icon), `${fileName} still uses ${icon}`);

    const prepend = body.match(/<template #prepend>([\s\S]*?)<\/template>/);
    assert.ok(prepend, `${fileName} header has a #prepend slot`);
    assert.match(prepend[1], /<span class="openai-key-icon[^"]*"[^>]*aria-hidden="true">/, fileName);
    assert.match(prepend[1], /<svg class="openai-key-icon__mark" viewBox="0 0 24 24"/, fileName);
    const paths = [...prepend[1].matchAll(/<path [^>]*\bd="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(paths, [OPENAI_LOGO_PATH], `${fileName} draws the OpenAI mark`);

    const badgeColor = prepend[1].match(/--badge-color: (#[0-9a-f]{6})/);
    if (badge) {
      assert.equal(badgeColor && badgeColor[1], ICON_BADGES[badge].color, fileName);
      assert.match(prepend[1], /<span class="openai-key-icon__badge"><\/span>/, fileName);
    } else {
      assert.equal(badgeColor, null, `${fileName} shows the plain mark`);
      assert.doesNotMatch(prepend[1], /openai-key-icon__badge/, fileName);
    }

    // The scoped styles that draw the tile, and a template that still nests.
    const style = content.match(/<style scoped>([\s\S]*?)<\/style>/);
    assert.ok(style && style[1].includes(".openai-key-icon {"), `${fileName} styles the mark`);
    assert.equal((content.match(/<template\b/g) || []).length, (content.match(/<\/template>/g) || []).length, fileName);
  }
});

test("key config pages offer no data source choice", () => {
  for (const fileName of ["session.vue", "token-usage.vue", "plan-usage.vue", "reset-timer.vue", "skill.vue"]) {
    const content = fs.readFileSync(path.join(UI_DIR, fileName), "utf8");
    const component = loadVueComponent(fileName);
    assert.doesNotMatch(content, /dataSource|Data source/, fileName);
    assert.equal((component.computed || {}).dataSource, undefined, fileName);
  }

  // Plan Usage and Reset Timer keys have nothing to configure: their pages never write the key.
  for (const fileName of ["plan-usage.vue", "reset-timer.vue"]) {
    const component = loadVueComponent(fileName);
    assert.equal(component.computed, undefined, fileName);
    assert.equal(component.methods, undefined, fileName);
  }
});

test("skill config page flags a saved skill that Codex does not list", async () => {
  const component = loadVueComponent("skill.vue");
  const codexSkills = [{ name: "diagnose" }, { name: "review" }];
  const mountSkillPage = (data, skills = codexSkills) => {
    const mounted = mountConfigComponent(component, {
      cid: "com.aspen.flexbar-ai-dashboard.skill",
      title: data.skillName || "AI Skill",
      style: {},
      data,
    });
    Object.assign(mounted.view, component.data(), {
      $fd: { sendToBackend: async (payload) => (payload.type === "skills" ? skills : null) },
    });
    return mounted;
  };

  // A key saved while it read another tool's skills keeps its name, flagged.
  const legacy = mountSkillPage({ dataSource: "claude", skillName: "made-up-skill" });
  assert.equal(legacy.view.skillNotFound, false, "nothing is flagged before the list loads");
  await legacy.view.refreshSkills();
  assert.equal(legacy.view.skillName, "made-up-skill");
  assert.equal(legacy.emitted.length, 0, "the saved skill stays until another one is picked");
  assert.equal(legacy.view.skillNotFound, true);
  assert.match(legacy.view.skillMessages[0], /Codex skills/);

  const listed = mountSkillPage({ skillName: "review" });
  await listed.view.refreshSkills();
  assert.equal(listed.view.skillNotFound, false);
  assert.equal(listed.view.skillMessages.length, 0);

  // A failed skills request flags nothing.
  const failed = mountSkillPage({ skillName: "review" }, { error: "boom" });
  await failed.view.refreshSkills();
  assert.equal(failed.view.skills.length, 0);
  assert.equal(failed.view.skillNotFound, false);

  // An empty key still gets the first Codex skill.
  const empty = mountSkillPage({ skillName: "" });
  await empty.view.refreshSkills();
  assert.equal(latestModel(empty.emitted).data.skillName, "diagnose");
});

test("new session config page writes project, prompt and mode into full key data model", () => {
  const component = loadVueComponent("new-session.vue");
  const model = {
    cid: "com.aspen.flexbar-ai-dashboard.new-session",
    title: "New Codex Session",
    style: {},
    data: {
      mode: "codex",
      projectPath: "",
      prompt: "",
    },
  };

  const project = mountConfigComponent(component, model);
  assert.equal(project.view.mode, "codex");
  assert.equal(project.view.projectPath, "");
  project.view.projectPath = " /Users/me/repo ";
  const afterProject = latestModel(project.emitted);
  assert.equal(afterProject.data.projectPath, "/Users/me/repo");
  assert.equal(afterProject.data.mode, "codex");
  assert.equal(afterProject.projectPath, undefined);

  const prompt = mountConfigComponent(component, model);
  prompt.view.prompt = "Review the diff";
  assert.equal(latestModel(prompt.emitted).data.prompt, "Review the diff");

  const mode = mountConfigComponent(component, model);
  mode.view.mode = "bogus";
  assert.equal(latestModel(mode.emitted).data.mode, "codex");

  const cleared = mountConfigComponent(component, { ...model, data: { ...model.data, projectPath: "/x" } });
  cleared.view.projectPath = null;
  assert.equal(latestModel(cleared.emitted).data.projectPath, "");
});

test("session and token usage config pages read settings from nested config models", () => {
  const session = mountConfigComponent(loadVueComponent("session.vue"), {
    data: {
      config: {
        sessionTitleMode: "latest",
      },
    },
  });
  const token = mountConfigComponent(loadVueComponent("token-usage.vue"), {
    config: {
      tokenDisplayMode: "recentChart",
    },
  });

  assert.equal(session.view.titleMode, "latest");
  assert.equal(token.view.displayMode, "recentChart");
});

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

function mountConfigComponent(component, modelValue) {
  const emitted = [];
  const view = {
    modelValue,
    $emit(event, value) {
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

function latestModel(emitted) {
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, "update:modelValue");
  return emitted[0].value;
}
