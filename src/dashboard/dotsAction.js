"use strict";

// Opens ChatGPT Dots when the key is pressed. The ChatGPT desktop app (bundle com.openai.codex) handles
// codex://dots only when the URL is exactly that string (a trailing slash or a query is ignored): it shows its
// window, goes to /dots and opens the primary dot, or the setup flow when there is none. If the link cannot be
// opened, Dots opens on the web instead. Only ever run on a real key press: opening the link moves the focus to
// ChatGPT.

const { createOpenUrlCommand, runCommand: defaultRunCommand } = require("./newSessionAction");

const DOTS_DEEP_LINK = "codex://dots";
const DOTS_WEB_URL = "https://chatgpt.com/dots";
const MAC_OPEN = "/usr/bin/open";

/** The command that opens `url` with the system handler (no shell). */
function dotsOpenCommand(url, platform = process.platform) {
  if (platform === "darwin") return { file: MAC_OPEN, args: [url] };
  return createOpenUrlCommand(url, platform);
}

/** -> { ok: true, target: "app" | "web" } or { ok: false, target: null, reason: "openFailed" }. Never throws. */
async function openChatGptDots(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.runCommand || defaultRunCommand;
  for (const [target, url] of [["app", DOTS_DEEP_LINK], ["web", DOTS_WEB_URL]]) {
    try {
      await run(dotsOpenCommand(url, platform));
      return { ok: true, target };
    } catch {
      // Try the next target; the error text (paths, exit codes) is not passed on.
    }
  }
  return { ok: false, target: null, reason: "openFailed" };
}

module.exports = {
  DOTS_DEEP_LINK,
  DOTS_WEB_URL,
  dotsOpenCommand,
  openChatGptDots,
};
