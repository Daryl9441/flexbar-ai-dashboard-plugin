#!/usr/bin/env node
"use strict";

// Runs FlexCLI (https://eniac-tech.github.io/FlexDocumentation/flexbar/en/sdk/flexcli.html)
// through npx, so the npm scripts work without `npm install -g @eniac/flexcli`.
//
// @eniac/flexcli 1.0.7 imports a JSON file with `assert { type: 'json' }`, which Node.js 22+
// rejects ("SyntaxError: Unexpected identifier 'assert'"). On Node.js 22+ this wrapper preloads
// scripts/flexcli-compat.mjs, which rewrites that import to `with { type: 'json' }` at load time.
//
// `plugin pack` zips the whole plugin folder, including config.json (local settings that FlexDesigner
// writes while the plugin is linked for development). The wrapper moves config.json out of the folder
// for the duration of the pack and puts it back afterwards, also when packing fails or is interrupted.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEFAULT_FLEXCLI_SPEC = "@eniac/flexcli@1.0.7";
const COMPAT_HOOK_PATH = path.join(__dirname, "flexcli-compat.mjs");
const IMPORT_ASSERTION_PATTERN = /\bassert(\s*\{\s*type\s*:\s*(["'])json\2\s*\})/g;
const PLUGIN_CONFIG_FILE = "config.json";
const GUARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Restore callbacks of packs in progress; run by the signal guard if the process is told to stop. */
const pendingRestores = new Set();

function nodeMajor(version = process.versions.node) {
  return Number.parseInt(String(version).replace(/^v/, "").split(".")[0], 10) || 0;
}

function needsImportAssertionCompat(version = process.versions.node) {
  return nodeMajor(version) >= 22;
}

function rewriteImportAssertions(source) {
  return String(source).replace(IMPORT_ASSERTION_PATTERN, "with$1");
}

function isFlexcliModuleUrl(url) {
  return /\/@eniac\/flexcli\/.+\.m?js$/.test(String(url));
}

function buildNodeOptions(existing, hookUrl) {
  const flag = `--import=${hookUrl}`;
  const current = String(existing || "").trim();
  if (current.includes(flag)) return current;
  return current ? `${current} ${flag}` : flag;
}

/**
 * Picks how to start npx without a shell where possible:
 * 1. under `npm run`, npm_execpath points at npm-cli.js and npx-cli.js sits next to it;
 * 2. on Windows, the npm bundled with Node.js (<node dir>\node_modules\npm\bin\npx-cli.js);
 * 3. `npx` on PATH (Windows: npx.cmd through cmd.exe, arguments quoted by quoteWindowsShellArg).
 */
function npxCommand(env = process.env, { platform = process.platform, execPath = process.execPath, exists = fs.existsSync } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const npmCli = env.npm_execpath;
  if (npmCli && /npm-cli\.c?js$/.test(npmCli)) {
    const npxCli = paths.join(paths.dirname(npmCli), "npx-cli.js");
    if (exists(npxCli)) return { command: execPath, prefix: [npxCli], shell: false };
  }
  if (platform === "win32") {
    const bundled = paths.join(paths.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
    if (exists(bundled)) return { command: execPath, prefix: [bundled], shell: false };
    return { command: "npx.cmd", prefix: [], shell: true };
  }
  return { command: "npx", prefix: [], shell: false };
}

/**
 * Quotes one argument for a `shell: true` spawn on Windows (cmd.exe running npx.cmd), so paths with
 * spaces or & | < > ^ ( ) stay one argument. %, ! and " cannot be passed through a batch file safely.
 */
function quoteWindowsShellArg(arg) {
  const value = String(arg);
  if (/["%!\r\n]/.test(value)) {
    throw new Error(
      `Cannot pass ${JSON.stringify(value)} through npx.cmd safely; run it via \`npm run\` (or Node.js' bundled npm) instead.`
    );
  }
  if (value !== "" && !/[\s&|<>^(),;=]/.test(value)) return value;
  // A trailing backslash would escape the closing quote for the program's argv parser.
  return `"${value.replace(/(\\+)$/, "$1$1")}"`;
}

/** Plugin folder of a `plugin pack --path <dir>` invocation (resolved against cwd), else null. */
function packPluginDir(args, cwd = process.cwd()) {
  const pluginIndex = args.indexOf("plugin");
  if (pluginIndex === -1 || args[pluginIndex + 1] !== "pack") return null;
  for (let i = pluginIndex + 2; i < args.length; i += 1) {
    if (args[i] === "--path" && i + 1 < args.length) return path.resolve(cwd, args[i + 1]);
    if (args[i].startsWith("--path=")) return path.resolve(cwd, args[i].slice("--path=".length));
  }
  return null;
}

/** Where config.json waits while its plugin folder is packed: next to (not inside) the folder. */
function configBackupPath(pluginDir) {
  const resolved = path.resolve(pluginDir);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.${PLUGIN_CONFIG_FILE}.pack-backup`);
}

/**
 * Moves <pluginDir>/config.json aside and returns an idempotent restore function.
 * A backup left by an interrupted earlier pack is restored first; if config.json was re-created since,
 * nothing is overwritten and an error asks the user to keep one of the two.
 */
function setConfigJsonAside(pluginDir, log = () => {}) {
  const configPath = path.join(pluginDir, PLUGIN_CONFIG_FILE);
  const backupPath = configBackupPath(pluginDir);
  if (fs.existsSync(backupPath)) {
    if (fs.existsSync(configPath)) {
      throw new Error(
        `${backupPath} (left by an interrupted pack) and ${configPath} both exist. ` +
        "Keep one of them (delete or move the other), then pack again."
      );
    }
    fs.renameSync(backupPath, configPath);
    log(`[flexcli] Restored ${configPath} from an interrupted pack.`);
  }
  if (!fs.existsSync(configPath)) return () => {};

  fs.renameSync(configPath, backupPath);
  log(`[flexcli] Moved ${PLUGIN_CONFIG_FILE} out of the plugin folder while packing; it is restored afterwards.`);
  let restored = false;
  return function restoreConfigJson() {
    if (restored) return;
    restored = true;
    if (fs.existsSync(configPath)) {
      log(`[flexcli] ${configPath} was re-created while packing; your previous one is kept at ${backupPath}.`);
      return;
    }
    fs.renameSync(backupPath, configPath);
  };
}

/**
 * Defers SIGINT/SIGTERM/SIGHUP while a pack runs: spawnSync blocks, so the handlers run once it returns
 * and config.json has been put back. They then restore anything still pending and re-raise the signal
 * so the process exits the way the caller expects.
 */
function installSignalGuard(proc = process) {
  const handlers = new Map();
  const onSignal = (signal) => {
    for (const restore of [...pendingRestores]) {
      try {
        restore();
      } catch (error) {
        console.error(`[flexcli] ${error.message}`);
      }
    }
    for (const [name, handler] of handlers) proc.removeListener(name, handler);
    try {
      proc.kill(proc.pid, signal);
    } catch {
      proc.exit(128 + (os.constants.signals[signal] || 1));
    }
  };
  for (const signal of GUARDED_SIGNALS) {
    handlers.set(signal, onSignal);
    proc.on(signal, onSignal);
  }
  return () => {
    for (const [name, handler] of handlers) proc.removeListener(name, handler);
  };
}

function runFlexcli(args, env = process.env, deps = {}) {
  const {
    spawn = spawnSync,
    platform = process.platform,
    execPath = process.execPath,
    nodeVersion = process.versions.node,
    cwd = process.cwd(),
    exists = fs.existsSync,
    log = (message) => console.error(message),
  } = deps;

  const childEnv = { ...env };
  if (needsImportAssertionCompat(nodeVersion)) {
    childEnv.NODE_OPTIONS = buildNodeOptions(childEnv.NODE_OPTIONS, pathToFileURL(COMPAT_HOOK_PATH).href);
  }
  const spec = env.FLEXCLI_SPEC || DEFAULT_FLEXCLI_SPEC;
  const npx = npxCommand(env, { platform, execPath, exists });
  let spawnArgs = [...npx.prefix, "--yes", spec, ...args];
  if (npx.shell) {
    try {
      spawnArgs = spawnArgs.map(quoteWindowsShellArg);
    } catch (error) {
      log(`[flexcli] ${error.message}`);
      return 1;
    }
  }

  let restore = () => {};
  const pluginDir = packPluginDir(args, cwd);
  if (pluginDir && fs.existsSync(pluginDir)) {
    try {
      restore = setConfigJsonAside(pluginDir, log);
    } catch (error) {
      log(`[flexcli] ${error.message}`);
      return 1;
    }
  }

  pendingRestores.add(restore);
  let status = 1;
  try {
    const result = spawn(npx.command, spawnArgs, { stdio: "inherit", env: childEnv, shell: npx.shell, cwd });
    if (result.error) {
      log(`[flexcli] Failed to start npx: ${result.error.message}`);
      log("[flexcli] 无法启动 npx，请确认已安装 Node.js 20.10+ 和 npm。");
    } else {
      status = result.status === null ? 1 : result.status;
    }
  } finally {
    pendingRestores.delete(restore);
    try {
      restore();
    } catch (error) {
      log(`[flexcli] Could not restore ${PLUGIN_CONFIG_FILE}: ${error.message} (backup: ${configBackupPath(pluginDir)})`);
      status = 1;
    }
  }
  return status;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const guarded = !!packPluginDir(args);
  if (guarded) installSignalGuard();
  process.exitCode = runFlexcli(args);
  // Signal handles do not keep the event loop alive: give it one more turn so a signal that arrived while
  // spawnSync was blocking is delivered to the guard (and re-raised) instead of being dropped.
  if (guarded) setImmediate(() => {});
}

module.exports = {
  DEFAULT_FLEXCLI_SPEC,
  buildNodeOptions,
  configBackupPath,
  installSignalGuard,
  isFlexcliModuleUrl,
  needsImportAssertionCompat,
  nodeMajor,
  npxCommand,
  packPluginDir,
  quoteWindowsShellArg,
  rewriteImportAssertions,
  runFlexcli,
  setConfigJsonAside,
};
