#!/usr/bin/env node
"use strict";

// Runs FlexCLI (https://eniac-tech.github.io/FlexDocumentation/flexbar/en/sdk/flexcli.html)
// through npx, so the npm scripts work without `npm install -g @eniac/flexcli`.
//
// @eniac/flexcli 1.0.7 imports a JSON file with `assert { type: 'json' }`, which Node.js 22+
// rejects ("SyntaxError: Unexpected identifier 'assert'"). On Node.js 22+ this wrapper preloads
// scripts/flexcli-compat.mjs, which rewrites that import to `with { type: 'json' }` at load time.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEFAULT_FLEXCLI_SPEC = "@eniac/flexcli@1.0.7";
const COMPAT_HOOK_PATH = path.join(__dirname, "flexcli-compat.mjs");
const IMPORT_ASSERTION_PATTERN = /\bassert(\s*\{\s*type\s*:\s*(["'])json\2\s*\})/g;

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

function npxCommand(env = process.env) {
  // Under `npm run`, npm_execpath points at npm-cli.js; npx-cli.js sits next to it.
  const npmCli = env.npm_execpath;
  if (npmCli && /npm-cli\.js$/.test(npmCli)) {
    const npxCli = path.join(path.dirname(npmCli), "npx-cli.js");
    if (fs.existsSync(npxCli)) return { command: process.execPath, prefix: [npxCli], shell: false };
  }
  if (process.platform === "win32") return { command: "npx.cmd", prefix: [], shell: true };
  return { command: "npx", prefix: [], shell: false };
}

function runFlexcli(args, env = process.env) {
  const childEnv = { ...env };
  if (needsImportAssertionCompat()) {
    childEnv.NODE_OPTIONS = buildNodeOptions(childEnv.NODE_OPTIONS, pathToFileURL(COMPAT_HOOK_PATH).href);
  }
  const spec = env.FLEXCLI_SPEC || DEFAULT_FLEXCLI_SPEC;
  const npx = npxCommand(env);
  const result = spawnSync(npx.command, [...npx.prefix, "--yes", spec, ...args], {
    stdio: "inherit",
    env: childEnv,
    shell: npx.shell,
  });
  if (result.error) {
    console.error(`[flexcli] Failed to start npx: ${result.error.message}`);
    console.error("[flexcli] 无法启动 npx，请确认已安装 Node.js 18+ 和 npm。");
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

if (require.main === module) {
  process.exitCode = runFlexcli(process.argv.slice(2));
}

module.exports = {
  DEFAULT_FLEXCLI_SPEC,
  buildNodeOptions,
  isFlexcliModuleUrl,
  needsImportAssertionCompat,
  nodeMajor,
  rewriteImportAssertions,
};
