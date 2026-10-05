#!/usr/bin/env node
"use strict";

// Preflight check for building, packing and installing the plugin locally.
// Usage: node scripts/doctor.cjs [--plugin-dir=<dir>] [--json]
// Env:   FLEX_TARGET=<platform>-<arch>  check a build meant for another OS (e.g. darwin-arm64, win32-x64)
//        FLEX_NODE_RUNTIME=<path>       Node.js binary used for the canvas load test (default: this Node)

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { needsImportAssertionCompat, nodeMajor } = require("./flexcli.cjs");

const MIN_NODE_MAJOR = 18;
const DEFAULT_PLUGIN_DIR = path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin");
const CANVAS_PACKAGE = "@napi-rs/canvas";

// Keep in sync with nativeCanvasPackage() in rollup.config.mjs. The first entry is the one the build copies.
const NATIVE_CANVAS_PACKAGES = {
  "darwin-arm64": ["@napi-rs/canvas-darwin-arm64", "@napi-rs/canvas-darwin-universal"],
  "darwin-x64": ["@napi-rs/canvas-darwin-x64", "@napi-rs/canvas-darwin-universal"],
  "win32-x64": ["@napi-rs/canvas-win32-x64-msvc"],
  "win32-arm64": ["@napi-rs/canvas-win32-arm64-msvc"],
  "linux-x64": ["@napi-rs/canvas-linux-x64-gnu", "@napi-rs/canvas-linux-x64-musl"],
  "linux-arm64": ["@napi-rs/canvas-linux-arm64-gnu", "@napi-rs/canvas-linux-arm64-musl"],
  "linux-arm": ["@napi-rs/canvas-linux-arm-gnueabihf"],
  "android-arm64": ["@napi-rs/canvas-android-arm64"],
};

const PLATFORM_ALIASES = {
  darwin: "darwin",
  mac: "darwin",
  macos: "darwin",
  osx: "darwin",
  win32: "win32",
  win: "win32",
  windows: "win32",
  linux: "linux",
  android: "android",
};

const ARCH_ALIASES = {
  arm64: "arm64",
  aarch64: "arm64",
  x64: "x64",
  amd64: "x64",
  x86_64: "x64",
  arm: "arm",
};

function parseTarget(value) {
  const match = /^([a-z0-9]+)[-./]([a-z0-9_]+)$/.exec(String(value || "").trim().toLowerCase());
  if (!match) return null;
  const platform = PLATFORM_ALIASES[match[1]];
  const arch = ARCH_ALIASES[match[2]];
  if (!platform || !arch) return null;
  return { platform, arch, id: `${platform}-${arch}` };
}

function resolveTarget({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const host = { platform, arch, id: `${platform}-${arch}` };
  const requested = env.FLEX_TARGET;
  if (requested === undefined || String(requested).trim() === "") {
    return { ...host, source: "host", host };
  }
  const parsed = parseTarget(requested);
  if (!parsed) return { platform: null, arch: null, id: null, source: "FLEX_TARGET", host, invalid: String(requested) };
  return { ...parsed, source: "FLEX_TARGET", host };
}

function expectedCanvasPackages(target) {
  if (!target || !target.id) return [];
  return NATIVE_CANVAS_PACKAGES[target.id] || [];
}

function targetForCanvasPackage(packageName) {
  for (const [id, names] of Object.entries(NATIVE_CANVAS_PACKAGES)) {
    if (names.includes(packageName)) return id;
  }
  return null;
}

function result(id, status, en, zh, fix) {
  return fix ? { id, status, en, zh, fix } : { id, status, en, zh };
}

function checkNodeVersion(version = process.versions.node) {
  const label = `Node.js v${String(version).replace(/^v/, "")}`;
  if (nodeMajor(version) < MIN_NODE_MAJOR) {
    return result(
      "node-version",
      "fail",
      `${label} is too old; FlexDesigner plugin development requires Node.js ${MIN_NODE_MAJOR}+.`,
      `${label} 版本过低，FlexDesigner 插件开发需要 Node.js ${MIN_NODE_MAJOR}+。`,
      {
        en: "Install Node.js 20 LTS (the SDK docs recommend nvm) and run npm install again.",
        zh: "安装 Node.js 20 LTS（SDK 文档推荐使用 nvm），然后重新执行 npm install。",
      }
    );
  }
  return result("node-version", "pass", `${label} (>= ${MIN_NODE_MAJOR})`, `${label}（要求 >= ${MIN_NODE_MAJOR}）`);
}

function checkFlexcliRuntime(version = process.versions.node) {
  if (!needsImportAssertionCompat(version)) {
    return result(
      "flexcli-runtime",
      "pass",
      "FlexCLI 1.0.7 runs natively on this Node.js version.",
      "FlexCLI 1.0.7 可以直接在当前 Node.js 版本上运行。"
    );
  }
  return result(
    "flexcli-runtime",
    "warn",
    "A plain `flexcli` (1.0.7) crashes on Node.js 22+ with \"SyntaxError: Unexpected identifier 'assert'\". " +
      "The npm run plugin:* scripts use scripts/flexcli.cjs, which patches this automatically.",
    "直接运行 `flexcli`（1.0.7）在 Node.js 22+ 上会报 \"SyntaxError: Unexpected identifier 'assert'\"。" +
      "npm run plugin:* 脚本通过 scripts/flexcli.cjs 调用，已自动兼容。",
    {
      en: "Use `npm run plugin:...` (or `node scripts/flexcli.cjs ...`) instead of a global flexcli, or switch to Node.js 20 LTS.",
      zh: "请使用 `npm run plugin:...`（或 `node scripts/flexcli.cjs ...`）代替全局 flexcli，或切换到 Node.js 20 LTS。",
    }
  );
}

function readManifest(pluginDir) {
  if (!fs.existsSync(pluginDir) || !fs.statSync(pluginDir).isDirectory()) {
    return {
      check: result(
        "manifest",
        "fail",
        `Plugin directory not found: ${pluginDir}`,
        `找不到插件目录：${pluginDir}`,
        { en: "Run the command from the repository root.", zh: "请在仓库根目录执行该命令。" }
      ),
    };
  }

  const manifestPath = path.join(pluginDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      check: result(
        "manifest",
        "fail",
        `manifest.json is missing or not valid JSON: ${error.message}`,
        `manifest.json 不存在或不是合法 JSON：${error.message}`,
        { en: "Restore manifest.json from git.", zh: "从 git 恢复 manifest.json。" }
      ),
    };
  }

  const uuid = manifest && typeof manifest.uuid === "string" ? manifest.uuid : "";
  const folder = path.basename(pluginDir);
  if (!uuid) {
    return { manifest, check: result("manifest", "fail", "manifest.json has no uuid.", "manifest.json 缺少 uuid。") };
  }
  if (folder !== `${uuid}.plugin` && folder !== uuid) {
    return {
      manifest,
      check: result(
        "manifest",
        "fail",
        `manifest uuid "${uuid}" does not match the plugin folder "${folder}" (expected "${uuid}.plugin").`,
        `manifest 中的 uuid "${uuid}" 与插件目录 "${folder}" 不一致（应为 "${uuid}.plugin"）。`,
        {
          en: "Rename the folder or fix manifest.uuid so they match.",
          zh: "重命名插件目录或修改 manifest.uuid，使两者一致。",
        }
      ),
    };
  }
  if (typeof manifest.entry !== "string" || !manifest.entry) {
    return { manifest, check: result("manifest", "fail", "manifest.json has no entry.", "manifest.json 缺少 entry。") };
  }
  return {
    manifest,
    check: result("manifest", "pass", `manifest.json is valid (uuid ${uuid})`, `manifest.json 有效（uuid ${uuid}）`),
  };
}

function checkBackendEntry(pluginDir, manifest) {
  const entry = path.join(pluginDir, manifest.entry);
  const size = fs.existsSync(entry) ? fs.statSync(entry).size : 0;
  if (size > 0) {
    return result("backend-entry", "pass", `Backend bundle found: ${manifest.entry}`, `已找到后端构建产物：${manifest.entry}`);
  }
  return result(
    "backend-entry",
    "fail",
    `Backend bundle ${manifest.entry} is missing or empty.`,
    `后端构建产物 ${manifest.entry} 不存在或为空。`,
    { en: "Run `npm install` and `npm run build`.", zh: "执行 `npm install` 和 `npm run build`。" }
  );
}

function backendModulesDir(pluginDir) {
  return path.join(pluginDir, "backend", "node_modules");
}

function listNativeCanvasPackages(pluginDir) {
  const scopeDir = path.join(backendModulesDir(pluginDir), "@napi-rs");
  if (!fs.existsSync(scopeDir)) return [];
  return fs.readdirSync(scopeDir)
    .filter((name) => name.startsWith("canvas-") && fs.existsSync(path.join(scopeDir, name, "package.json")))
    .map((name) => `@napi-rs/${name}`)
    .sort();
}

function checkCanvasPackage(pluginDir) {
  const packageJson = path.join(backendModulesDir(pluginDir), ...CANVAS_PACKAGE.split("/"), "package.json");
  if (fs.existsSync(packageJson)) {
    return result("canvas-js", "pass", `${CANVAS_PACKAGE} is bundled in backend/node_modules`, `backend/node_modules 中已包含 ${CANVAS_PACKAGE}`);
  }
  return result(
    "canvas-js",
    "fail",
    `${CANVAS_PACKAGE} is missing from backend/node_modules, so keys can only show their default icons.`,
    `backend/node_modules 中缺少 ${CANVAS_PACKAGE}，按键只能显示默认图标。`,
    { en: "Run `npm install` and `npm run build`.", zh: "执行 `npm install` 和 `npm run build`。" }
  );
}

function checkNativeCanvas(target, installedPackages) {
  if (!target.id) {
    return result(
      "canvas-native",
      "fail",
      `FLEX_TARGET="${target.invalid}" is not a valid target; use <platform>-<arch>, e.g. darwin-arm64 or win32-x64.`,
      `FLEX_TARGET="${target.invalid}" 无效，请使用 <platform>-<arch> 格式，例如 darwin-arm64 或 win32-x64。`
    );
  }

  const expected = expectedCanvasPackages(target);
  if (expected.length === 0) {
    return result(
      "canvas-native",
      "fail",
      `No @napi-rs/canvas native package is known for ${target.id}.`,
      `没有适用于 ${target.id} 的 @napi-rs/canvas 原生包。`
    );
  }

  const present = expected.find((name) => installedPackages.includes(name));
  if (present) {
    return result("canvas-native", "pass", `Native canvas for ${target.id}: ${present}`, `${target.id} 的原生 canvas：${present}`);
  }

  const foreign = installedPackages.length ? installedPackages.join(", ") : "none";
  const foreignTargets = installedPackages.map(targetForCanvasPackage).filter(Boolean);
  const builtOn = foreignTargets.length ? ` This backend was built on ${[...new Set(foreignTargets)].join("/")}.` : "";
  const builtOnZh = foreignTargets.length ? `该后端是在 ${[...new Set(foreignTargets)].join("/")} 上构建的。` : "";
  return result(
    "canvas-native",
    "fail",
    `backend/node_modules has no ${expected[0]} (found: ${foreign}).${builtOn} ` +
      "@napi-rs/canvas cannot load, so keys only show their default icons instead of Codex/Claude data.",
    `backend/node_modules 中缺少 ${expected[0]}（实际找到：${foreign === "none" ? "无" : foreign}）。${builtOnZh}` +
      "@napi-rs/canvas 无法加载，按键只会显示默认图标，不会显示 Codex/Claude 数据。",
    target.source === "host"
      ? {
        en: "Build on this machine: `npm install && npm run build`, then `npm run plugin:pack`.",
        zh: "在本机构建：`npm install && npm run build`，然后执行 `npm run plugin:pack`。",
      }
      : {
        en: `Build on a ${target.id} machine (or a CI runner for it), or install ${expected[0]} into node_modules before \`npm run build\`.`,
        zh: `请在 ${target.id} 机器（或对应的 CI runner）上构建，或在 \`npm run build\` 前把 ${expected[0]} 安装到 node_modules。`,
      }
  );
}

const CANVAS_LOAD_SCRIPT = `
"use strict";
const Module = require("node:module");
const path = require("node:path");
const root = path.resolve(process.argv[1]);
const inside = (dir) => dir === root || dir.startsWith(root + path.sep);
const nodeModulePaths = Module._nodeModulePaths;
Module._nodeModulePaths = function (from) { return nodeModulePaths.call(this, from).filter(inside); };
Module.globalPaths.length = 0;
try {
  const canvasDir = path.join(root, "backend", "node_modules", "@napi-rs", "canvas");
  const canvas = require(canvasDir);
  const surface = canvas.createCanvas(1, 1);
  const ctx = surface.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 1, 1);
  const png = surface.toBuffer("image/png");
  let binding = null;
  for (const name of JSON.parse(process.argv[2])) {
    try { binding = require.resolve(name, { paths: [canvasDir] }); break; } catch {}
  }
  process.stdout.write(JSON.stringify({ ok: true, pngBytes: png.length, binding }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message || error).split("\\n")[0] }));
  process.exitCode = 1;
}
`;

function loadCanvasInChild(pluginDir, candidates, env = process.env) {
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  delete childEnv.NODE_PATH;
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NAPI_RS_NATIVE_LIBRARY_PATH;
  delete childEnv.NAPI_RS_FORCE_WASI;
  const runtime = env.FLEX_NODE_RUNTIME || process.execPath;
  const child = spawnSync(runtime, ["-e", CANVAS_LOAD_SCRIPT, path.resolve(pluginDir), JSON.stringify(candidates)], {
    encoding: "utf8",
    env: childEnv,
    timeout: 30_000,
  });
  if (child.error) return { ok: false, error: child.error.message };
  try {
    return JSON.parse(child.stdout);
  } catch {
    const stderr = String(child.stderr || "").trim().split("\n")[0];
    return { ok: false, error: stderr || `exit code ${child.status}` };
  }
}

function checkCanvasLoads(pluginDir, target, previous, loader = loadCanvasInChild, env = process.env) {
  if (!target.id) {
    return result("canvas-load", "skip", "Skipped canvas load test (invalid FLEX_TARGET).", "已跳过 canvas 加载测试（FLEX_TARGET 无效）。");
  }
  if (target.id !== target.host.id) {
    return result(
      "canvas-load",
      "skip",
      `Skipped canvas load test: a ${target.id} binary cannot be loaded on ${target.host.id}.`,
      `已跳过 canvas 加载测试：无法在 ${target.host.id} 上加载 ${target.id} 的二进制。`
    );
  }
  if (previous.some((check) => (check.id === "canvas-js" || check.id === "canvas-native") && check.status === "fail")) {
    return result("canvas-load", "skip", "Skipped canvas load test (canvas packages missing).", "已跳过 canvas 加载测试（缺少 canvas 包）。");
  }

  const outcome = loader(pluginDir, expectedCanvasPackages(target), env);
  if (outcome && outcome.ok) {
    const binding = outcome.binding ? path.relative(pluginDir, outcome.binding) : "native binding";
    return result(
      "canvas-load",
      "pass",
      `@napi-rs/canvas loads from the plugin folder alone and renders PNG (${binding})`,
      `仅依赖插件目录即可加载 @napi-rs/canvas 并生成 PNG（${binding}）`
    );
  }
  const error = (outcome && outcome.error) || "unknown error";
  return result(
    "canvas-load",
    "fail",
    `@napi-rs/canvas failed to load from backend/node_modules: ${error}`,
    `无法从 backend/node_modules 加载 @napi-rs/canvas：${error}`,
    {
      en: "Delete com.aspen.flexbar-ai-dashboard.plugin/backend, then run `npm install && npm run build` on this machine.",
      zh: "删除 com.aspen.flexbar-ai-dashboard.plugin/backend 后，在本机重新执行 `npm install && npm run build`。",
    }
  );
}

function runDoctor(options = {}) {
  const env = options.env || process.env;
  const pluginDir = path.resolve(options.pluginDir || DEFAULT_PLUGIN_DIR);
  const nodeVersion = options.nodeVersion || process.versions.node;
  const target = resolveTarget({ env, platform: options.platform, arch: options.arch });
  const checks = [checkNodeVersion(nodeVersion), checkFlexcliRuntime(nodeVersion)];

  const { manifest, check } = readManifest(pluginDir);
  checks.push(check);
  if (check.status === "pass") {
    checks.push(checkBackendEntry(pluginDir, manifest));
    checks.push(checkCanvasPackage(pluginDir));
    checks.push(checkNativeCanvas(target, listNativeCanvasPackages(pluginDir)));
    checks.push(checkCanvasLoads(pluginDir, target, checks, options.loadCanvas, env));
  }

  return { pluginDir, nodeVersion, target, checks, ok: checks.every((item) => item.status !== "fail") };
}

function summarize(checks) {
  const count = (status) => checks.filter((item) => item.status === status).length;
  return { pass: count("pass"), warn: count("warn"), fail: count("fail"), skip: count("skip") };
}

function formatReport(report) {
  const target = report.target.id
    ? `${report.target.id}${report.target.source === "host" ? " (this machine / 本机)" : " (FLEX_TARGET)"}`
    : `invalid FLEX_TARGET "${report.target.invalid}"`;
  const lines = [
    "Flexbar AI Dashboard doctor / 本地环境自检",
    `Plugin / 插件: ${report.pluginDir}`,
    `Target / 目标平台: ${target}, Node.js v${String(report.nodeVersion).replace(/^v/, "")}`,
    "",
  ];

  for (const item of report.checks) {
    lines.push(`[${item.status.toUpperCase()}] ${item.en}`);
    lines.push(`       ${item.zh}`);
    if (item.fix && item.status !== "pass") {
      lines.push(`       Fix: ${item.fix.en}`);
      lines.push(`       修复：${item.fix.zh}`);
    }
  }

  const totals = summarize(report.checks);
  lines.push("");
  if (report.ok) {
    lines.push(`OK: ${totals.pass} passed, ${totals.warn} warning(s). Ready to pack and install.`);
    lines.push(`通过：${totals.pass} 项通过，${totals.warn} 项警告，可以打包并安装。`);
  } else {
    lines.push(`FAILED: ${totals.fail} check(s) failed. Fix them before packing or installing the plugin.`);
    lines.push(`失败：${totals.fail} 项检查未通过，请修复后再打包或安装插件。`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { json: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg.startsWith("--plugin-dir=")) options.pluginDir = arg.slice("--plugin-dir=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error("Usage: node scripts/doctor.cjs [--plugin-dir=<dir>] [--json]");
    return 2;
  }
  const report = runDoctor(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  NATIVE_CANVAS_PACKAGES,
  checkCanvasLoads,
  checkFlexcliRuntime,
  checkNativeCanvas,
  checkNodeVersion,
  expectedCanvasPackages,
  formatReport,
  listNativeCanvasPackages,
  parseArgs,
  parseTarget,
  readManifest,
  resolveTarget,
  runDoctor,
  summarize,
  targetForCanvasPackage,
};
