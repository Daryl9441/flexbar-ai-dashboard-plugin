"use strict";

const { renderOpenAiIcon } = require("./openaiLogo");

// The skill key is drawn by the host from key.style (its icon until a skill is chosen,
// then the skill name). Its default icon is the OpenAI mark with the yellow skill badge,
// as in the key library; keys placed before that carry the old default, which is the
// only icon replaced (a custom icon stays).
const LEGACY_SKILL_ICON = "mdi mdi-star-four-points";
// Same size as the key-library icons in manifest.json (scripts/generate-icons.cjs).
const SKILL_ICON_SIZE = 96;
// The host centers an mdi glyph (which has padding of its own) at iconPos, but draws an
// image edge to edge, iconSize px tall, centered 3px above iconPos: an image icon gets
// a smaller box higher up so it clears the title at Y 72%.
const GLYPH_ICON_STYLE = Object.freeze({ maxSize: 34, pos: Object.freeze({ X: 50, Y: 50 }) });
const IMAGE_ICON_STYLE = Object.freeze({ maxSize: 26, pos: Object.freeze({ X: 50, Y: 33 }) });

// Canvas module (undefined: the bundled one) -> rendered default icon.
const defaultIcons = new Map();

/**
 * The default skill key icon: a PNG data URI of the OpenAI skill icon, rendered once per canvas module, or the old
 * mdi star when it cannot be rendered.
 */
function defaultSkillIcon(canvasModule) {
  if (!defaultIcons.has(canvasModule)) {
    let icon;
    try {
      icon = renderOpenAiIcon({ size: SKILL_ICON_SIZE, badge: "skill", canvasModule });
    } catch {
      icon = LEGACY_SKILL_ICON;
    }
    defaultIcons.set(canvasModule, icon);
  }
  return defaultIcons.get(canvasModule);
}

function updateSkillConfigModel(modelValue, patch) {
  const model = isObject(modelValue) ? modelValue : {};
  const nextPatch = isObject(patch) ? patch : {};

  if (isObject(model.config)) {
    const config = {
      ...model.config,
      ...nextPatch,
    };
    return withSkillTitle({
      ...model,
      config,
    }, config.skillName);
  }

  if (isFullKeyModelWithData(model)) {
    const data = {
      ...model.data,
      ...nextPatch,
    };
    return withSkillTitle({
      ...model,
      data,
    }, data.skillName);
  }

  return {
    ...model,
    ...nextPatch,
  };
}

function skillNameFromKey(key) {
  return firstNonBlankString(
    key && key.config && key.config.skillName,
    key && key.data && key.data.config && key.data.config.skillName,
    key && key.data && key.data.skillName,
    key && key.modelValue && key.modelValue.config && key.modelValue.config.skillName,
    key && key.modelValue && key.modelValue.skillName
  );
}

function configureDefaultSkillKey(key, fallbackTitle, options = {}) {
  if (!key) return null;
  const skillName = skillNameFromKey(key);
  key.title = skillName || fallbackTitle || "Select skill";
  key.style = isObject(key.style) ? key.style : {};
  if (!key.style.icon || key.style.icon === LEGACY_SKILL_ICON) {
    key.style.icon = defaultSkillIcon(options.canvasModule);
  }
  const iconStyle = isImageIcon(key.style.icon) ? IMAGE_ICON_STYLE : GLYPH_ICON_STYLE;
  key.style.iconSize = Math.min(Number(key.style.iconSize) || iconStyle.maxSize, iconStyle.maxSize);
  key.style.fontSize = Math.min(Number(key.style.fontSize) || 18, 18);
  key.style.iconPos = { ...iconStyle.pos };
  key.style.titlePos = key.style.titlePos || { X: 50, Y: 72 };
  key.style.showIcon = !skillName;
  key.style.showTitle = true;
  key.style.showImage = false;
  return key;
}

function isImageIcon(icon) {
  return typeof icon === "string" && icon.startsWith("data:image/");
}

function firstNonBlankString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function withSkillTitle(model, skillName) {
  const title = String(skillName || "").trim();
  if (!title) return model;
  return {
    ...model,
    title,
  };
}

function isFullKeyModelWithData(model) {
  return isObject(model.data) && (
    Object.prototype.hasOwnProperty.call(model, "cid") ||
    Object.prototype.hasOwnProperty.call(model, "style") ||
    Object.prototype.hasOwnProperty.call(model, "title")
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  LEGACY_SKILL_ICON,
  configureDefaultSkillKey,
  defaultSkillIcon,
  skillNameFromKey,
  updateSkillConfigModel,
};
