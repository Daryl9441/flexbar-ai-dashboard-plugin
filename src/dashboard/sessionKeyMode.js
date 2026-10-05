"use strict";

// What an AI Session key shows. Each tap moves it one step:
// home (its own session) -> overview (all sessions) -> automations (scheduled tasks) -> home.
const SESSION_KEY_MODE = Object.freeze({
  HOME: "home",
  OVERVIEW: "overview",
  AUTOMATIONS: "automations",
});

// Anything unknown (including no mode at all) counts as home.
function nextSessionKeyMode(mode) {
  if (mode === SESSION_KEY_MODE.OVERVIEW) return SESSION_KEY_MODE.AUTOMATIONS;
  if (mode === SESSION_KEY_MODE.AUTOMATIONS) return SESSION_KEY_MODE.HOME;
  return SESSION_KEY_MODE.OVERVIEW;
}

module.exports = {
  SESSION_KEY_MODE,
  nextSessionKeyMode,
};
