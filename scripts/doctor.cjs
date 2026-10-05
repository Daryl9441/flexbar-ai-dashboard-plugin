#!/usr/bin/env node
"use strict";

// Preflight check for building, packing and installing the plugin locally.
// Usage: node scripts/doctor.cjs [--plugin-dir=<dir>] [--json]
// Env:   FLEX_TARGET=<targets>      the targets the build bundled, same syntax as `npm run build`
//                                   (scripts/native-canvas.cjs): "darwin-arm64,win32-x64", "darwin", "win32", "all", "host"
//        FLEX_NODE_RUNTIME=<path>   runtime used for the canvas load test (default on macOS: FlexDesigner's own
//                                   plugin runtime, "FlexDesigner Helper" with ELECTRON_RUN_AS_NODE=1; otherwise this Node.js)

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const nativeCanvas = require("./native-canvas.cjs");
const { configBackupPath, needsImportAssertionCompat } = require("./flexcli.cjs");

// @eniac/flexcli 1.0.7 imports JSON with import attributes (`with { type: 'json' }`, validate.js) next to the
// older import assertions (`assert`, pack.js). Import attributes need Node.js 18.20+/20.10+; 18.x is EOL, so 20.10.
const MIN_NODE_VERSION = "20.10.0";
const DEFAULT_PLUGIN_DIR = path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin");
const CANVAS_PACKAGE = nativeCanvas.CANVAS_PACKAGE;
// FlexDesigner (macOS) starts plugin backends with this Electron helper in Node mode.
const FLEXDESIGNER_MAC_RUNTIME =
  "/Applications/FlexDesigner.app/Contents/Frameworks/FlexDesigner Helper.app/Contents/MacOS/FlexDesigner Helper";

function result(id, status, en, zh, fix) {
  return fix ? { id, status, en, zh, fix } : { id, status, en, zh };
}

function parseVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch };
}

function versionAtLeast(version, minimum) {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

/** Resolves FLEX_TARGET exactly like the build (rollup.config.mjs -> scripts/native-canvas.cjs). */
function resolveTargets({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const raw = env.FLEX_TARGET === undefined || env.FLEX_TARGET === null ? "" : String(env.FLEX_TARGET);
  const spec = raw.trim();
  const host = `${platform}-${arch}`;
  const source = spec ? "FLEX_TARGET" : "host";
  try {
    return { ids: nativeCanvas.resolveCanvasTargets(raw, { platform, arch }), spec, source, host };
  } catch (error) {
    return { ids: [], spec, source, host, error: error.message };
  }
}

function targetForCanvasPackage(packageName) {
  for (const id of Object.keys(nativeCanvas.NATIVE_CANVAS_TARGETS)) {
    if (nativeCanvas.nativeCanvasPackageName(id) === packageName) return id;
  }
  return null;
}

/** Build commands that reproduce the checked targets (POSIX shell and PowerShell). */
function buildCommands(targets, command = "npm run build") {
  if (targets.source === "host") return { posix: command, powershell: command };
  const value = /^[\w.,@/-]+$/.test(targets.spec) ? targets.spec : targets.ids.join(",");
  return { posix: `FLEX_TARGET=${value} ${command}`, powershell: `$env:FLEX_TARGET='${value}'; ${command}` };
}

function rebuildFix(targets) {
  const cmd = buildCommands(targets);
  if (targets.source === "host") {
    return {
      en: "Rebuild on this machine: `npm install && npm run build`.",
      zh: "在本机重新构建：`npm install && npm run build`。",
    };
  }
  return {
    en: `Rebuild with \`${cmd.posix}\` (PowerShell: \`${cmd.powershell}\`); missing binaries are fetched at the installed ${CANVAS_PACKAGE} version.`,
    zh: `执行 \`${cmd.posix}\`（PowerShell：\`${cmd.powershell}\`）重新构建，缺少的二进制会按已安装的 ${CANVAS_PACKAGE} 版本自动下载。`,
  };
}

function checkNodeVersion(version = process.versions.node) {
  const label = `Node.js v${String(version).replace(/^v/, "")}`;
  if (!versionAtLeast(version, MIN_NODE_VERSION)) {
    return result(
      "node-version",
      "fail",
      `${label} is too old: FlexCLI 1.0.7 (used to pack/install) needs import attributes, i.e. Node.js ${MIN_NODE_VERSION}+.`,
      `${label} 版本过低：打包/安装使用的 FlexCLI 1.0.7 依赖 import attributes，需要 Node.js ${MIN_NODE_VERSION}+。`,
      {
        en: "Install Node.js 22 LTS (or 20.10+), e.g. with nvm, then run `npm install` again.",
        zh: "安装 Node.js 22 LTS（或 20.10+，可使用 nvm），然后重新执行 `npm install`。",
      }
    );
  }
  return result("node-version", "pass", `${label} (>= ${MIN_NODE_VERSION})`, `${label}（要求 >= ${MIN_NODE_VERSION}）`);
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
      en: "Use `npm run plugin:...` (or `node scripts/flexcli.cjs ...`) instead of a global flexcli.",
      zh: "请使用 `npm run plugin:...`（或 `node scripts/flexcli.cjs ...`）代替全局 flexcli。",
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

/**
 * config.json holds local plugin settings written through FlexDesigner (e.g. path overrides). In the source
 * folder it is dev state that must not ship: scripts/flexcli.cjs moves it aside while packing.
 * An installed copy (folder named after the bare uuid) legitimately keeps its config.json, so it is not checked.
 */
function checkConfigJson(pluginDir, manifest) {
  if (path.basename(pluginDir) !== `${manifest.uuid}.plugin`) return [];
  const checks = [];
  const configPath = path.join(pluginDir, "config.json");
  const backupPath = configBackupPath(pluginDir);
  if (fs.existsSync(backupPath)) {
    checks.push(result(
      "config-backup",
      "warn",
      `${backupPath} was left by an interrupted \`plugin pack\`; it holds your local config.json.`,
      `${backupPath} 是中断的 \`plugin pack\` 留下的本地 config.json 备份。`,
      fs.existsSync(configPath)
        ? {
          en: `Keep one of ${configPath} and the backup (delete or move the other); packing refuses to run while both exist.`,
          zh: `请在 ${configPath} 与该备份之间保留一个（删除或移走另一个）；两者同时存在时打包会拒绝执行。`,
        }
        : {
          en: "The next `npm run plugin:pack` restores it, or move it back to config.json in the plugin folder.",
          zh: "下次执行 `npm run plugin:pack` 会自动恢复，也可手动移回插件目录下的 config.json。",
        }
    ));
  }
  if (fs.existsSync(configPath)) {
    checks.push(result(
      "config-json",
      "warn",
      "config.json (local plugin settings, e.g. path overrides) is in the plugin folder. " +
        "`npm run plugin:pack` keeps it out of the .flexplugin; a plain `flexcli plugin pack` would ship it.",
      "插件目录中存在 config.json（本地插件设置，例如路径覆盖）。`npm run plugin:pack` 打包时会排除它；直接运行 `flexcli plugin pack` 则会把它打进 .flexplugin。",
      {
        en: "Pack with `npm run plugin:pack`. Delete config.json only if you want to reset the local settings.",
        zh: "请用 `npm run plugin:pack` 打包。只有想重置本地设置时才需要删除 config.json。",
      }
    ));
  }
  return checks;
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

function packageDir(pluginDir, packageName) {
  return path.join(backendModulesDir(pluginDir), ...packageName.split("/"));
}

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
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
  const packageJson = readPackageJson(packageDir(pluginDir, CANVAS_PACKAGE));
  if (packageJson && packageJson.name === CANVAS_PACKAGE && packageJson.version) {
    return {
      version: packageJson.version,
      check: result(
        "canvas-js",
        "pass",
        `${CANVAS_PACKAGE}@${packageJson.version} is bundled in backend/node_modules`,
        `backend/node_modules 中已包含 ${CANVAS_PACKAGE}@${packageJson.version}`
      ),
    };
  }
  return {
    version: null,
    check: result(
      "canvas-js",
      "fail",
      `${CANVAS_PACKAGE} is missing from backend/node_modules, so keys can only show their default icons.`,
      `backend/node_modules 中缺少 ${CANVAS_PACKAGE}，按键只能显示默认图标。`,
      { en: "Run `npm install` and `npm run build`.", zh: "执行 `npm install` 和 `npm run build`。" }
    ),
  };
}

/** Returns null when <dir> holds <name>@<version> built for <target> with a non-empty binary, else the problem. */
function nativePackageProblem(dir, name, version, target) {
  const packageJson = readPackageJson(dir);
  if (!packageJson) return { en: "missing", zh: "缺失" };
  if (packageJson.name !== name || packageJson.version !== version) {
    const found = `${packageJson.name}@${packageJson.version}`;
    return {
      en: `found ${found}, expected ${name}@${version} (must match the bundled ${CANVAS_PACKAGE})`,
      zh: `实际为 ${found}，应为 ${name}@${version}（必须与打包的 ${CANVAS_PACKAGE} 版本一致）`,
    };
  }
  const [platform, arch] = target.split("-");
  if ((Array.isArray(packageJson.os) && !packageJson.os.includes(platform)) ||
    (Array.isArray(packageJson.cpu) && !packageJson.cpu.includes(arch))) {
    const built = `${[].concat(packageJson.os || "?").join("/")}-${[].concat(packageJson.cpu || "?").join("/")}`;
    return { en: `package targets ${built}, not ${target}`, zh: `该包面向 ${built}，而不是 ${target}` };
  }
  const main = typeof packageJson.main === "string" ? packageJson.main : "";
  const binary = main.endsWith(".node") ? path.join(dir, main) : null;
  if (!binary || !fs.existsSync(binary) || fs.statSync(binary).size === 0) {
    return { en: `native binary ${main || "(no main)"} is missing or empty`, zh: `原生二进制 ${main || "（无 main）"} 不存在或为空` };
  }
  return null;
}

function checkNativeCanvas(pluginDir, target, canvasVersion, targets, installedPackages) {
  const name = nativeCanvas.nativeCanvasPackageName(target);
  const problem = nativePackageProblem(packageDir(pluginDir, name), name, canvasVersion, target);
  if (!problem) {
    const check = result("canvas-native", "pass", `Native canvas for ${target}: ${name}@${canvasVersion}`, `${target} 的原生 canvas：${name}@${canvasVersion}`);
    return { ...check, target };
  }

  let found = "";
  let foundZh = "";
  if (problem.en === "missing") {
    const others = installedPackages.filter((item) => item !== name);
    const builtFor = [...new Set(others.map(targetForCanvasPackage).filter(Boolean))];
    found = ` (found: ${others.length ? others.join(", ") : "none"}${builtFor.length ? `; this backend was built for ${builtFor.join("/")}` : ""})`;
    foundZh = `（实际找到：${others.length ? others.join(", ") : "无"}${builtFor.length ? `；该后端是为 ${builtFor.join("/")} 构建的` : ""}）`;
  }
  const check = result(
    "canvas-native",
    "fail",
    `Native canvas for ${target}: ${name} ${problem.en}${found}. ` +
      `On ${target}, ${CANVAS_PACKAGE} cannot load, so keys only show their default icons instead of Codex/Claude data.`,
    `${target} 的原生 canvas：${name} ${problem.zh}${foundZh}。` +
      `在 ${target} 上 ${CANVAS_PACKAGE} 无法加载，按键只会显示默认图标，不会显示 Codex/Claude 数据。`,
    rebuildFix(targets)
  );
  return { ...check, target };
}

/**
 * Picks the runtime for the canvas load test: FLEX_NODE_RUNTIME, else (macOS) FlexDesigner's plugin runtime,
 * else this Node.js. `kind` is "override", "flexdesigner" or "node".
 */
function resolveLoadRuntime({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  flexDesignerRuntime = FLEXDESIGNER_MAC_RUNTIME,
  exists = fs.existsSync,
} = {}) {
  if (env.FLEX_NODE_RUNTIME) return { path: env.FLEX_NODE_RUNTIME, kind: "override" };
  if (platform === "darwin") {
    if (exists(flexDesignerRuntime)) return { path: flexDesignerRuntime, kind: "flexdesigner" };
    return { path: execPath, kind: "node", missing: flexDesignerRuntime };
  }
  return { path: execPath, kind: "node" };
}

function runtimeLabel(runtime, outcome) {
  const details = [outcome.target, outcome.node && `Node ${outcome.node}`, outcome.electron && `Electron ${outcome.electron}`]
    .filter(Boolean)
    .join(", ");
  const en = details ? ` (${details})` : "";
  const zh = details ? `（${details}）` : "";
  if (runtime.kind === "flexdesigner") return { en: `FlexDesigner's plugin runtime${en}`, zh: `FlexDesigner 插件运行时${zh}` };
  if (runtime.kind === "override") return { en: `FLEX_NODE_RUNTIME ${runtime.path}${en}`, zh: `FLEX_NODE_RUNTIME ${runtime.path}${zh}` };
  return { en: `this Node.js${en}`, zh: `当前 Node.js${zh}` };
}

// Runs in the load-test runtime: argv[1] = plugin dir, argv[2] = {"requested": {target: package}, "ready": [target]}.
// It only loads canvas when the runtime's own <platform>-<arch> is a requested target whose package passed the checks,
// so a binary built for another OS/CPU is never loaded. Module lookups are confined to the plugin folder.
const CANVAS_LOAD_SCRIPT = `
"use strict";
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const target = process.platform + "-" + process.arch;
const info = { target: target, node: process.versions.node, electron: process.versions.electron || null };
const report = (data) => process.stdout.write(JSON.stringify(Object.assign({}, info, data)));
try {
  const plan = JSON.parse(process.argv[2]);
  if (!Object.prototype.hasOwnProperty.call(plan.requested, target)) {
    report({ ok: false, skipped: "not-requested" });
  } else if (plan.ready.indexOf(target) === -1) {
    report({ ok: false, skipped: "not-ready" });
  } else {
    // Node resolves modules by their real path, so compare real paths: /tmp, $TMPDIR (/var -> /private/var)
    // and symlinked workspaces would otherwise look like they are outside the plugin folder.
    const root = fs.realpathSync(path.resolve(process.argv[1]));
    const inside = (dir) => dir === root || dir.startsWith(root + path.sep);
    const nodeModulePaths = Module._nodeModulePaths;
    Module._nodeModulePaths = function (from) { return nodeModulePaths.call(this, from).filter(inside); };
    Module.globalPaths.length = 0;
    const canvas = require(path.join(root, "backend", "node_modules", "@napi-rs", "canvas"));
    const surface = canvas.createCanvas(1, 1);
    const ctx = surface.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 1, 1);
    const png = surface.toBuffer("image/png");
    const binding = Object.keys(require.cache).filter((file) => file.endsWith(".node"))[0] || null;
    if (binding && !inside(binding)) throw new Error("native binding was loaded from outside the plugin folder: " + binding);
    report({ ok: true, pngBytes: png.length, binding: binding });
  }
} catch (error) {
  report({ ok: false, error: String((error && error.message) || error).split("\\n")[0] });
  process.exitCode = 1;
}
`;

function loadCanvasInChild(pluginDir, plan, runtime = { path: process.execPath }, env = process.env) {
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  delete childEnv.NODE_PATH;
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NAPI_RS_NATIVE_LIBRARY_PATH;
  delete childEnv.NAPI_RS_FORCE_WASI;
  const child = spawnSync(runtime.path, ["-e", CANVAS_LOAD_SCRIPT, path.resolve(pluginDir), JSON.stringify(plan)], {
    encoding: "utf8",
    env: childEnv,
    timeout: 30_000,
    windowsHide: true,
  });
  if (child.error) return { ok: false, spawnError: child.error.message };
  try {
    return JSON.parse(child.stdout);
  } catch {
    const stderr = String(child.stderr || "").trim().split("\n")[0];
    return { ok: false, error: stderr || `exit code ${child.status}` };
  }
}

function checkCanvasLoads({ pluginDir, targets, runtime, nativeChecks, loader, env }) {
  const checks = [];
  if (runtime.missing) {
    checks.push(result(
      "load-runtime",
      "warn",
      `FlexDesigner was not found at ${runtime.missing}, so the canvas load test uses this Node.js (${runtime.path}) instead of FlexDesigner's plugin runtime.`,
      `未在 ${runtime.missing} 找到 FlexDesigner，canvas 加载测试改用当前 Node.js（${runtime.path}），而不是 FlexDesigner 的插件运行时。`,
      {
        en: "Install FlexDesigner in /Applications, or set FLEX_NODE_RUNTIME to the binary that runs the plugin.",
        zh: "将 FlexDesigner 安装到 /Applications，或用 FLEX_NODE_RUNTIME 指定实际运行插件的可执行文件。",
      }
    ));
  }

  const requested = {};
  for (const id of targets.ids) requested[id] = nativeCanvas.nativeCanvasPackageName(id);
  const ready = nativeChecks.filter((check) => check.status === "pass").map((check) => check.target);
  const outcome = loader(pluginDir, { requested, ready }, runtime, env) || { ok: false, error: "no result" };

  if (outcome.spawnError) {
    checks.push(result(
      "canvas-load",
      "fail",
      `Could not start the load-test runtime ${runtime.path}: ${outcome.spawnError}`,
      `无法启动加载测试运行时 ${runtime.path}：${outcome.spawnError}`,
      runtime.kind === "override"
        ? { en: "Point FLEX_NODE_RUNTIME at an existing Node.js/Electron binary or unset it.", zh: "请将 FLEX_NODE_RUNTIME 指向存在的 Node.js/Electron 可执行文件，或取消该变量。" }
        : { en: "Reinstall FlexDesigner, or set FLEX_NODE_RUNTIME to a Node.js binary.", zh: "重新安装 FlexDesigner，或用 FLEX_NODE_RUNTIME 指定一个 Node.js。" }
    ));
    return { checks, outcome };
  }

  const where = runtimeLabel(runtime, outcome);
  const runsPlugin = runtime.kind !== "node";
  if (outcome.skipped === "not-requested") {
    if (runsPlugin && targets.source === "host") {
      const cmd = buildCommands({ source: "FLEX_TARGET", spec: outcome.target, ids: [outcome.target] }, "npm run plugin:install");
      checks.push(result(
        "canvas-load",
        "fail",
        `${where.en} needs the ${outcome.target} binary, but this build only bundles ${targets.ids.join(", ")} ` +
          "(the platform of the Node.js that ran npm), so FlexDesigner on this machine could not render key images.",
        `${where.zh} 需要 ${outcome.target} 的二进制，但本次构建只包含 ${targets.ids.join(", ")}（执行 npm 的 Node.js 的平台），本机 FlexDesigner 将无法渲染按键图片。`,
        {
          en: `Use a ${outcome.target} Node.js, or build for it: \`${cmd.posix}\` (PowerShell: \`${cmd.powershell}\`).`,
          zh: `请改用 ${outcome.target} 的 Node.js，或为其构建：\`${cmd.posix}\`（PowerShell：\`${cmd.powershell}\`）。`,
        }
      ));
    } else if (runsPlugin) {
      checks.push(result(
        "canvas-load",
        "warn",
        `${where.en} needs the ${outcome.target} binary, which FLEX_TARGET=${targets.spec} does not include: ` +
          "fine for packing for other machines, but do not install this build here.",
        `${where.zh} 需要 ${outcome.target} 的二进制，FLEX_TARGET=${targets.spec} 不包含该平台：可以为其他机器打包，但不要在本机安装此构建。`
      ));
    } else {
      checks.push(result(
        "canvas-load",
        "skip",
        `Skipped canvas load test: ${where.en} matches none of the targets (${targets.ids.join(", ")}); ` +
          "binaries for other platforms are checked for presence and version only, never loaded.",
        `已跳过 canvas 加载测试：${where.zh} 不属于目标平台（${targets.ids.join(", ")}）；其他平台的二进制只检查是否存在及版本，不会加载。`
      ));
    }
    return { checks, outcome };
  }
  if (outcome.skipped === "not-ready") {
    checks.push(result(
      "canvas-load",
      "skip",
      `Skipped canvas load test in ${where.en}: its native package failed the check above.`,
      `已跳过在 ${where.zh} 中的 canvas 加载测试：对应的原生包未通过上面的检查。`
    ));
    return { checks, outcome };
  }

  if (outcome.ok) {
    const binding = outcome.binding ? path.relative(fs.realpathSync(pluginDir), outcome.binding) : "native binding";
    checks.push(result(
      "canvas-load",
      "pass",
      `${CANVAS_PACKAGE} loads in ${where.en} from the plugin folder alone and renders PNG (${binding})`,
      `${CANVAS_PACKAGE} 在 ${where.zh} 中仅依赖插件目录即可加载并生成 PNG（${binding}）`
    ));
  } else {
    const fix = rebuildFix(targets);
    checks.push(result(
      "canvas-load",
      "fail",
      `${CANVAS_PACKAGE} failed to load from backend/node_modules in ${where.en}: ${outcome.error || "unknown error"}`,
      `在 ${where.zh} 中无法从 backend/node_modules 加载 ${CANVAS_PACKAGE}：${outcome.error || "未知错误"}`,
      {
        en: `Delete ${path.basename(pluginDir)}/backend, then ${fix.en.charAt(0).toLowerCase()}${fix.en.slice(1)}`,
        zh: `删除 ${path.basename(pluginDir)}/backend 后，${fix.zh}`,
      }
    ));
  }
  return { checks, outcome };
}

function checkRuntimeArch(targets, outcomeTarget) {
  if (!outcomeTarget || outcomeTarget === targets.host) return null;
  return result(
    "runtime-arch",
    "warn",
    `This Node.js runs as ${targets.host}, but the plugin runtime loads the ${outcomeTarget} binary. ` +
      `\`npm install\` only installs ${targets.host} binaries, so a build without FLEX_TARGET would miss ${outcomeTarget}.`,
    `当前 Node.js 以 ${targets.host} 运行，而插件运行时加载的是 ${outcomeTarget} 的二进制。` +
      `\`npm install\` 只安装 ${targets.host} 的二进制，不设置 FLEX_TARGET 的构建会缺少 ${outcomeTarget}。`,
    {
      en: `Keep FLEX_TARGET including ${outcomeTarget} for build/pack/install, or use a ${outcomeTarget} Node.js.`,
      zh: `构建/打包/安装时请让 FLEX_TARGET 包含 ${outcomeTarget}，或改用 ${outcomeTarget} 的 Node.js。`,
    }
  );
}

function runDoctor(options = {}) {
  const env = options.env || process.env;
  const pluginDir = path.resolve(options.pluginDir || DEFAULT_PLUGIN_DIR);
  const nodeVersion = options.nodeVersion || process.versions.node;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const targets = resolveTargets({ env, platform, arch });
  const runtime = options.runtime || resolveLoadRuntime({
    env,
    platform,
    execPath: options.execPath,
    flexDesignerRuntime: options.flexDesignerRuntime,
    exists: options.exists,
  });
  const checks = [checkNodeVersion(nodeVersion), checkFlexcliRuntime(nodeVersion)];

  const { manifest, check } = readManifest(pluginDir);
  checks.push(check);
  if (check.status === "pass") {
    checks.push(...checkConfigJson(pluginDir, manifest));
    checks.push(checkBackendEntry(pluginDir, manifest));
    const canvas = checkCanvasPackage(pluginDir);
    checks.push(canvas.check);

    if (targets.error) {
      checks.push(result(
        "flex-target",
        "fail",
        `Unsupported target: ${targets.error}`,
        `不支持的目标平台：${targets.error}`,
        {
          en: "Use a target the build supports, e.g. `FLEX_TARGET=all npm run build` (PowerShell: `$env:FLEX_TARGET='all'; npm run build`).",
          zh: "请使用构建支持的目标平台，例如 `FLEX_TARGET=all npm run build`（PowerShell：`$env:FLEX_TARGET='all'; npm run build`）。",
        }
      ));
    } else if (!canvas.version) {
      checks.push(result("canvas-native", "skip", "Skipped native canvas checks (canvas package missing).", "已跳过原生 canvas 检查（缺少 canvas 包）。"));
    } else {
      const installed = listNativeCanvasPackages(pluginDir);
      const nativeChecks = targets.ids.map((target) => checkNativeCanvas(pluginDir, target, canvas.version, targets, installed));
      checks.push(...nativeChecks);
      const load = checkCanvasLoads({
        pluginDir,
        targets,
        runtime,
        nativeChecks,
        loader: options.loadCanvas || loadCanvasInChild,
        env,
      });
      checks.push(...load.checks);
      const archWarning = load.outcome.ok && checkRuntimeArch(targets, load.outcome.target);
      if (archWarning) checks.push(archWarning);
    }
  }

  return {
    pluginDir,
    nodeVersion,
    targets,
    runtime,
    checks,
    ok: checks.every((item) => item.status !== "fail"),
  };
}

function summarize(checks) {
  const count = (status) => checks.filter((item) => item.status === status).length;
  return { pass: count("pass"), warn: count("warn"), fail: count("fail"), skip: count("skip") };
}

function formatTargets(targets) {
  if (targets.error) return `unsupported FLEX_TARGET "${targets.spec}"`;
  const list = targets.ids.join(", ");
  return targets.source === "host" ? `${list} (this machine / 本机)` : `${list} (FLEX_TARGET=${targets.spec})`;
}

function formatReport(report) {
  const lines = [
    "Flexbar AI Dashboard doctor / 本地环境自检",
    `Plugin / 插件: ${report.pluginDir}`,
    `Target / 目标平台: ${formatTargets(report.targets)}, Node.js v${String(report.nodeVersion).replace(/^v/, "")}`,
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
  CANVAS_LOAD_SCRIPT,
  FLEXDESIGNER_MAC_RUNTIME,
  MIN_NODE_VERSION,
  buildCommands,
  checkFlexcliRuntime,
  checkNodeVersion,
  formatReport,
  listNativeCanvasPackages,
  loadCanvasInChild,
  parseArgs,
  readManifest,
  resolveLoadRuntime,
  resolveTargets,
  runDoctor,
  summarize,
  targetForCanvasPackage,
  versionAtLeast,
};
