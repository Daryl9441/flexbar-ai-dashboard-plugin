"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const canvasModule = require("@napi-rs/canvas");
const { ICON_BADGES, renderOpenAiIcon } = require("../src/dashboard/openaiLogo");
const {
  LEGACY_SKILL_ICON,
  configureDefaultSkillKey,
  defaultSkillIcon,
  skillNameFromKey,
  updateSkillConfigModel,
} = require("../src/dashboard/skillKey");

const MANIFEST = path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin", "manifest.json");

test("skill config update supports full key model and syncs title", () => {
  const next = updateSkillConfigModel({
    title: "AI Skill",
    config: {
      dataSource: "codex",
      skillName: "",
    },
  }, {
    skillName: "diagnose",
  });

  assert.deepEqual(next.config, {
    dataSource: "codex",
    skillName: "diagnose",
  });
  assert.equal(next.title, "diagnose");
});

test("skill config update supports full key model with data field", () => {
  const next = updateSkillConfigModel({
    cid: "com.aspen.flexbar-ai-dashboard.skill",
    title: "AI Skill",
    data: {
      dataSource: "codex",
      skillName: "",
    },
  }, {
    skillName: "triage",
  });

  assert.deepEqual(next.data, {
    dataSource: "codex",
    skillName: "triage",
  });
  assert.equal(next.title, "triage");
});

test("skill config update preserves legacy data-only model shape", () => {
  assert.deepEqual(updateSkillConfigModel({
    dataSource: "codex",
    skillName: "",
  }, {
    skillName: "git-commit",
  }), {
    dataSource: "codex",
    skillName: "git-commit",
  });
});

test("skill name reader accepts saved skillName from data or config", () => {
  assert.equal(skillNameFromKey({ data: { skillName: "diagnose" } }), "diagnose");
  assert.equal(skillNameFromKey({ config: { skillName: "git-commit" } }), "git-commit");
  assert.equal(skillNameFromKey({ data: { config: { skillName: "triage" } } }), "triage");
});

test("default skill key hides icon when title is the selected skill", () => {
  const key = {
    title: "AI Skill",
    data: { skillName: "diagnose" },
    style: {
      icon: "mdi mdi-star-four-points",
      showIcon: false,
      showTitle: false,
    },
  };

  configureDefaultSkillKey(key, "Select skill");

  assert.equal(key.title, "diagnose");
  assert.equal(key.style.showIcon, false);
  assert.equal(key.style.showTitle, true);
  assert.equal(key.style.showImage, false);
});

test("default skill key keeps icon when no skill is selected", () => {
  const key = {
    title: "AI Skill",
    data: { skillName: "" },
    style: {
      icon: "mdi mdi-star-four-points",
      showIcon: false,
      showTitle: false,
    },
  };

  configureDefaultSkillKey(key, "Select skill");

  assert.equal(key.title, "Select skill");
  assert.equal(key.style.showIcon, true);
  // The old default star became the OpenAI skill icon, an image drawn above the title.
  assert.equal(key.style.icon, defaultSkillIcon());
  assert.deepEqual(key.style.iconPos, { X: 50, Y: 33 });
  assert.equal(key.style.showTitle, true);
  assert.equal(key.style.showImage, false);
});

test("the default skill icon is the OpenAI mark with the skill badge, rendered once", async () => {
  const icon = defaultSkillIcon();
  assert.match(icon, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  assert.equal(defaultSkillIcon(), icon, "cached");

  const png = Buffer.from(icon.slice(icon.indexOf(",") + 1), "base64");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96]);
  const pixels = await decode(icon);
  assert.ok(countColor(pixels, [255, 255, 255]) > 96 * 96 * 0.05, "the white mark");
  assert.ok(countColor(pixels, hexToRgb(ICON_BADGES.skill.color)) > 96 * 96 * 0.02, "the yellow skill badge");

  // The skill key's key-library icon in manifest.json looks the same (`npm run icons` keeps it current).
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const manifestIcon = manifest.keyLibrary.children.find((child) => child.cid.endsWith(".skill")).style.icon;
  assert.ok(maxChannelDifference(await decode(manifestIcon), pixels) <= 8, "manifest skill icon matches the default");

  // One render per canvas module, however many keys are configured.
  let renders = 0;
  const counting = Object.create(canvasModule);
  counting.createCanvas = (...args) => {
    renders += 1;
    return canvasModule.createCanvas(...args);
  };
  const keys = [{ style: {} }, { style: { icon: LEGACY_SKILL_ICON } }, { style: { icon: "" } }];
  for (const key of keys) configureDefaultSkillKey(key, "Select skill", { canvasModule: counting });
  configureDefaultSkillKey(keys[0], "Select skill", { canvasModule: counting });
  assert.equal(renders, 1);
  const counted = defaultSkillIcon(counting);
  assert.ok(keys.every((key) => key.style.icon === counted));
  assert.equal(counted, renderOpenAiIcon({ size: 96, badge: "skill", canvasModule }), "same pixels, same PNG");
});

test("the AI Skill key-library style already has the geometry the plugin gives its image icon", () => {
  // FlexDesigner copies this style as is onto a newly placed key and draws it until the
  // plugin first does (and whenever the plugin is not running): the image must clear the title.
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const child = manifest.keyLibrary.children.find((entry) => entry.cid.endsWith(".skill"));
  assert.match(child.style.icon, /^data:image\//);
  const key = { data: structuredClone(child.data), style: structuredClone(child.style) };
  configureDefaultSkillKey(key, "Select skill");
  for (const field of ["icon", "iconSize", "iconPos", "titlePos", "fontSize", "showTitle"]) {
    assert.deepEqual(key.style[field], child.style[field], field);
  }
  assert.equal(child.style.iconSize, 26);
  assert.deepEqual(child.style.iconPos, { X: 50, Y: 33 });
});

test("default skill key replaces only the legacy star, never an icon the user picked", () => {
  const custom = [
    "mdi mdi-rocket-launch",
    "mdi mdi-star-four-points-outline",
    "data:image/png;base64,iVBORw0KGgo=",
  ];
  for (const icon of custom) {
    const key = { data: { skillName: "" }, style: { icon, iconSize: 34 } };
    configureDefaultSkillKey(key, "Select skill");
    assert.equal(key.style.icon, icon);
  }

  // An mdi glyph keeps the old geometry; any image icon is drawn smaller, above the title.
  const glyph = { style: { icon: "mdi mdi-rocket-launch", iconSize: 40 } };
  configureDefaultSkillKey(glyph, "Select skill");
  assert.equal(glyph.style.iconSize, 34);
  assert.deepEqual(glyph.style.iconPos, { X: 50, Y: 50 });
  const image = { style: { icon: "data:image/png;base64,iVBORw0KGgo=", iconSize: 34 } };
  configureDefaultSkillKey(image, "Select skill");
  assert.equal(image.style.iconSize, 26);
  assert.deepEqual(image.style.iconPos, { X: 50, Y: 33 });
  const small = { style: { icon: LEGACY_SKILL_ICON, iconSize: 20 } };
  configureDefaultSkillKey(small, "Select skill");
  assert.equal(small.style.iconSize, 20, "a smaller size the user set stays");

  // Missing style or icon: the OpenAI icon.
  const bare = { data: {} };
  configureDefaultSkillKey(bare, "Select skill");
  assert.equal(bare.style.icon, defaultSkillIcon());
  assert.equal(bare.style.iconSize, 26);
  assert.deepEqual(bare.style.titlePos, { X: 50, Y: 72 });
});

test("default skill key falls back to the legacy star when the icon cannot be rendered", () => {
  for (const icon of [undefined, "", LEGACY_SKILL_ICON]) {
    const key = { style: { icon, iconSize: 34 } };
    configureDefaultSkillKey(key, "Select skill", { canvasModule: null });
    assert.equal(key.style.icon, LEGACY_SKILL_ICON);
    assert.equal(key.style.iconSize, 34);
    assert.deepEqual(key.style.iconPos, { X: 50, Y: 50 });
  }
  assert.equal(defaultSkillIcon({ createCanvas() { throw new Error("no canvas"); } }), LEGACY_SKILL_ICON);
});

async function decode(dataUri) {
  const image = await canvasModule.loadImage(Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64"));
  const canvas = canvasModule.createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height).data;
}

function countColor(data, [r, g, b]) {
  let count = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset] === r && data[offset + 1] === g && data[offset + 2] === b && data[offset + 3] === 255) count += 1;
  }
  return count;
}

function maxChannelDifference(a, b) {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let index = 0; index < a.length; index += 1) max = Math.max(max, Math.abs(a[index] - b[index]));
  return max;
}

function hexToRgb(hex) {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
}
