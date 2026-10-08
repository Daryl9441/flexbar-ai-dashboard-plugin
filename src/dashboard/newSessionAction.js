"use strict";

const { execFile } = require("node:child_process");

// The ChatGPT desktop app (bundle com.openai.codex) registers the codex:// scheme.
// codex://threads/new opens a fresh thread; mode picks the app surface, path picks
// the project folder, and prompt is prefilled into the focused composer (not sent).
const CODEX_NEW_THREAD_URL = "codex://threads/new";
const CODEX_APP_MODES = ["codex", "work", "chat"];
const DEFAULT_CODEX_APP_MODE = "codex";
// ShellExecute on Windows has historically rejected URLs longer than ~2083 chars.
const WINDOWS_MAX_URL_LENGTH = 2000;

function normalizeCodexAppMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return CODEX_APP_MODES.includes(mode) ? mode : DEFAULT_CODEX_APP_MODE;
}

function validateProjectPath(value) {
  const projectPath = String(value || "").trim();
  if (!projectPath) return { ok: true, path: "" };
  if (/^[\\/]{2}/.test(projectPath)) {
    return { ok: false, error: "Network paths are not supported" };
  }
  if (!isAbsolutePath(projectPath)) {
    return { ok: false, error: "Project folder must be an absolute path" };
  }
  return { ok: true, path: projectPath };
}

function buildCodexNewThreadUrl(options = {}) {
  const params = new URLSearchParams();
  params.set("mode", normalizeCodexAppMode(options.mode));

  const projectPath = validateProjectPath(options.projectPath);
  if (!projectPath.ok) throw new Error(projectPath.error);
  if (projectPath.path) params.set("path", projectPath.path);

  const prompt = String(options.prompt || "").trim();
  if (prompt) params.set("prompt", prompt);

  return `${CODEX_NEW_THREAD_URL}?${params.toString()}`;
}

function createOpenUrlCommand(url, platform = process.platform) {
  if (platform === "darwin") {
    return { file: "open", args: [url] };
  }
  if (platform === "win32") {
    const encodedUrl = Buffer.from(String(url), "utf16le").toString("base64");
    const script = `Start-Process -FilePath ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedUrl}')))`;
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }
  return { file: "xdg-open", args: [url] };
}

async function openNewCodexSession(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.runCommand || runCommand;

  let url;
  try {
    url = buildCodexNewThreadUrl(options);
  } catch (error) {
    return { ok: false, reason: "invalidProject", error: error.message };
  }
  if (platform === "win32" && url.length > WINDOWS_MAX_URL_LENGTH) {
    return { ok: false, reason: "promptTooLong", url, error: `URL is ${url.length} characters` };
  }

  try {
    await run(createOpenUrlCommand(url, platform));
    return { ok: true, url };
  } catch (error) {
    return { ok: false, reason: "openFailed", url, error: error && error.message || String(error) };
  }
}

function listRecentProjectPaths(snapshot, limit = 10) {
  const codex = snapshot && snapshot.providers && snapshot.providers.codex;
  const sessions = codex && Array.isArray(codex.sessions) ? codex.sessions : [];
  const seen = new Set();
  const paths = [];
  for (const session of sessions) {
    const cwd = session && typeof session.cwd === "string" ? session.cwd.trim() : "";
    if (!cwd || seen.has(cwd) || !validateProjectPath(cwd).ok) continue;
    seen.add(cwd);
    paths.push(cwd);
    if (paths.length >= limit) break;
  }
  return paths;
}

function projectLabel(projectPath) {
  const text = String(projectPath || "").trim().replace(/[\\/]+$/, "");
  if (!text) return "";
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || text;
}

function isAbsolutePath(value) {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args || [], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

module.exports = {
  CODEX_APP_MODES,
  DEFAULT_CODEX_APP_MODE,
  WINDOWS_MAX_URL_LENGTH,
  buildCodexNewThreadUrl,
  createOpenUrlCommand,
  listRecentProjectPaths,
  normalizeCodexAppMode,
  openNewCodexSession,
  projectLabel,
  runCommand,
  validateProjectPath,
};
