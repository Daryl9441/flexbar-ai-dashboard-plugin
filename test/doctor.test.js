"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const nativeCanvas = require("../scripts/native-canvas.cjs");
const { configBackupPath } = require("../scripts/flexcli.cjs");
const {
  MIN_NODE_VERSION,
  checkFlexcliRuntime,
  checkNodeVersion,
  formatReport,
  loadCanvasInChild,
  parseArgs,
  resolveLoadRuntime,
  resolveTargets,
  runDoctor,
  targetForCanvasPackage,
  versionAtLeast,
} = require("../scripts/doctor.cjs");

const repoRoot = path.join(__dirname, "..");
const CANVAS_VERSION = "0.1.100";
const DARWIN_ARM64 = { platform: "darwin", arch: "arm64" };
const FLEXDESIGNER = { path: "/Applications/FlexDesigner.app/Contents/Frameworks/FlexDesigner Helper", kind: "flexdesigner" };
const PLAIN_NODE = { path: "/usr/local/bin/node", kind: "node" };

function tempDir(t, prefix = "flexbar-doctor-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

/** A native package as the build bundles it: name/version/os/cpu/main plus a non-empty binary. */
function nativePackage(target, overrides = {}) {
  const [platform, arch] = target.split("-");
  const suffix = nativeCanvas.NATIVE_CANVAS_TARGETS[target];
  return {
    name: nativeCanvas.nativeCanvasPackageName(target),
    version: CANVAS_VERSION,
    os: [platform],
    cpu: [arch],
    main: `skia.${suffix}.node`,
    binary: "binary",
    ...overrides,
  };
}

function makePluginDir(t, {
  folder = "com.example.demo.plugin",
  manifest,
  targets = [],
  packages = [],
  withCanvas = true,
  entry = "bundle",
  config,
} = {}) {
  const pluginDir = path.join(tempDir(t), folder);
  fs.mkdirSync(path.join(pluginDir, "backend"), { recursive: true });
  writeJson(path.join(pluginDir, "manifest.json"), manifest === undefined
    ? { uuid: "com.example.demo", entry: "backend/plugin.cjs" }
    : manifest);
  if (entry) fs.writeFileSync(path.join(pluginDir, "backend", "plugin.cjs"), entry, "utf8");
  if (config !== undefined) writeJson(path.join(pluginDir, "config.json"), config);
  const modules = path.join(pluginDir, "backend", "node_modules");
  if (withCanvas) writeJson(path.join(modules, "@napi-rs", "canvas", "package.json"), { name: "@napi-rs/canvas", version: CANVAS_VERSION });
  for (const pkg of [...targets.map((target) => nativePackage(target)), ...packages]) {
    const dir = path.join(modules, ...pkg.name.split("/"));
    const { binary, ...packageJson } = pkg;
    writeJson(path.join(dir, "package.json"), packageJson);
    if (binary !== undefined && pkg.main) fs.writeFileSync(path.join(dir, pkg.main), binary);
  }
  return pluginDir;
}

function byId(report, id) {
  return report.checks.find((item) => item.id === id);
}

function allById(report, id) {
  return report.checks.filter((item) => item.id === id);
}

function statuses(report) {
  return report.checks.map((item) => `${item.id}:${item.status}`);
}

function recordingLoader(outcome) {
  const calls = [];
  const loader = (dir, plan, runtime) => {
    calls.push({ dir, plan, runtime });
    return typeof outcome === "function" ? outcome(plan) : outcome;
  };
  return { calls, loader };
}

test("doctor resolves FLEX_TARGET exactly like the build (scripts/native-canvas.cjs)", () => {
  const specs = [undefined, "", "  ", "host", "all", "darwin", "win32", "darwin-arm64,win32-x64", "darwin-arm64 win32-x64-msvc", "@napi-rs/canvas-darwin-x64", "ALL"];
  const hosts = [DARWIN_ARM64, { platform: "linux", arch: "x64" }, { platform: "win32", arch: "x64" }];
  for (const host of hosts) {
    for (const spec of specs) {
      const env = spec === undefined ? {} : { FLEX_TARGET: spec };
      const resolved = resolveTargets({ env, ...host });
      assert.deepEqual(resolved.ids, nativeCanvas.resolveCanvasTargets(spec, host), `FLEX_TARGET=${spec} on ${host.platform}-${host.arch}`);
      assert.equal(resolved.source, spec && spec.trim() ? "FLEX_TARGET" : "host");
      assert.equal(resolved.host, `${host.platform}-${host.arch}`);
    }
  }

  const unknown = resolveTargets({ env: { FLEX_TARGET: "darwin-arm64,freebsd-x64" }, ...DARWIN_ARM64 });
  assert.deepEqual(unknown.ids, []);
  assert.match(unknown.error, /Unknown FLEX_TARGET entry "freebsd-x64"/);
  assert.match(resolveTargets({ env: {}, platform: "freebsd", arch: "x64" }).error, /freebsd-x64/);
});

test("the doctor checks the native packages the build bundles (rollup -> scripts/native-canvas.cjs)", () => {
  const rollupConfig = fs.readFileSync(path.join(repoRoot, "rollup.config.mjs"), "utf8");
  assert.match(rollupConfig, /import nativeCanvas from "\.\/scripts\/native-canvas\.cjs"/);
  assert.match(rollupConfig, /nativeCanvas\.resolveCanvasTargets\(process\.env\.FLEX_TARGET\)/);
  assert.match(rollupConfig, /nativeCanvas\.bundleNativeCanvas\(/);

  for (const target of Object.keys(nativeCanvas.NATIVE_CANVAS_TARGETS)) {
    assert.equal(targetForCanvasPackage(nativeCanvas.nativeCanvasPackageName(target)), target);
  }
  assert.equal(targetForCanvasPackage("@napi-rs/canvas"), null);
  assert.equal(targetForCanvasPackage("@napi-rs/canvas-darwin-universal"), null);
});

test("checkNodeVersion requires Node.js 20.10+ (FlexCLI 1.0.7 uses import attributes)", () => {
  assert.equal(MIN_NODE_VERSION, "20.10.0");
  for (const version of ["16.20.2", "18.20.4", "19.9.0", "20.9.0", "v20.9.9"]) {
    assert.equal(checkNodeVersion(version).status, "fail", version);
  }
  for (const version of ["20.10.0", "20.18.1", "21.0.0", "22.0.0", "v25.9.0"]) {
    assert.equal(checkNodeVersion(version).status, "pass", version);
  }
  const failure = checkNodeVersion("20.9.0");
  assert.match(failure.en, /import attributes/);
  assert.match(failure.en, /20\.10\.0\+/);
  assert.equal(versionAtLeast("20.10.0", "20.10.0"), true);
  assert.equal(versionAtLeast("20.2.0", "20.10.0"), false);

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=20.10");
});

test("checkFlexcliRuntime warns that a plain flexcli 1.0.7 breaks on Node.js 22+", () => {
  assert.equal(checkFlexcliRuntime("20.18.0").status, "pass");
  const warning = checkFlexcliRuntime("22.22.0");
  assert.equal(warning.status, "warn");
  assert.match(warning.en, /Unexpected identifier 'assert'/);
  assert.match(warning.fix.en, /scripts\/flexcli\.cjs/);
});

test("runDoctor passes and loads only the target of the runtime that runs the plugin", (t) => {
  const pluginDir = makePluginDir(t, { targets: ["darwin-arm64", "darwin-x64", "win32-x64"] });
  const { calls, loader } = recordingLoader({ ok: true, target: "darwin-arm64", node: "22.22.0", electron: "38.8.6", binding: null });
  const report = runDoctor({
    pluginDir,
    env: { FLEX_TARGET: "all" },
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: loader,
  });

  assert.equal(report.ok, true, statuses(report).join(" "));
  assert.deepEqual(report.checks.map((item) => item.status), Array(report.checks.length).fill("pass"));
  assert.deepEqual(allById(report, "canvas-native").map((item) => item.target), ["darwin-arm64", "darwin-x64", "win32-x64"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dir, pluginDir);
  assert.equal(calls[0].runtime, FLEXDESIGNER);
  assert.deepEqual(calls[0].plan, {
    requested: {
      "darwin-arm64": "@napi-rs/canvas-darwin-arm64",
      "darwin-x64": "@napi-rs/canvas-darwin-x64",
      "win32-x64": "@napi-rs/canvas-win32-x64-msvc",
    },
    ready: ["darwin-arm64", "darwin-x64", "win32-x64"],
  });
  assert.match(byId(report, "canvas-load").en, /FlexDesigner's plugin runtime \(darwin-arm64, Node 22\.22\.0, Electron 38\.8\.6\)/);
});

test("runDoctor passes on a CI runner packing macOS binaries it cannot load", (t) => {
  const pluginDir = makePluginDir(t, { targets: ["darwin-arm64", "darwin-x64"] });
  const runtime = resolveLoadRuntime({ env: { FLEX_TARGET: "darwin" }, platform: "linux", execPath: "/usr/bin/node" });
  assert.deepEqual(runtime, { path: "/usr/bin/node", kind: "node" });
  const { calls, loader } = recordingLoader({ ok: false, skipped: "not-requested", target: "linux-x64", node: "20.18.0", electron: null });

  const report = runDoctor({
    pluginDir,
    env: { FLEX_TARGET: "darwin" },
    platform: "linux",
    arch: "x64",
    nodeVersion: "20.18.0",
    runtime,
    loadCanvas: loader,
  });

  assert.equal(report.ok, true, statuses(report).join(" "));
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].plan.requested), ["darwin-arm64", "darwin-x64"]);
  const load = byId(report, "canvas-load");
  assert.equal(load.status, "skip");
  assert.match(load.en, /matches none of the targets \(darwin-arm64, darwin-x64\)/);
  assert.match(load.en, /never loaded/);
  assert.equal(report.checks.filter((item) => item.status === "warn").length, 0);
});

test("the load-test child never loads a binary for another platform", (t) => {
  const host = `${process.platform}-${process.arch}`;
  const foreign = host === "win32-x64" ? "darwin-arm64" : "win32-x64";
  // No @napi-rs/canvas at all: requiring it would fail, so a clean "not-requested" proves nothing was loaded.
  const pluginDir = makePluginDir(t, { withCanvas: false });
  const outcome = loadCanvasInChild(
    pluginDir,
    { requested: { [foreign]: nativeCanvas.nativeCanvasPackageName(foreign) }, ready: [foreign] },
    { path: process.execPath, kind: "node" }
  );

  assert.equal(outcome.skipped, "not-requested");
  assert.equal(outcome.target, host);
  assert.equal(outcome.node, process.versions.node);
});

test("runDoctor fails when the backend only has another platform's canvas binary", (t) => {
  const pluginDir = makePluginDir(t, { targets: ["linux-x64"] });
  const { calls, loader } = recordingLoader({ ok: false, skipped: "not-ready", target: "darwin-arm64", node: "22.22.0" });
  const report = runDoctor({ pluginDir, env: {}, ...DARWIN_ARM64, nodeVersion: "20.18.0", runtime: FLEXDESIGNER, loadCanvas: loader });

  assert.equal(report.ok, false);
  const native = byId(report, "canvas-native");
  assert.equal(native.status, "fail");
  assert.equal(native.target, "darwin-arm64");
  assert.match(native.en, /@napi-rs\/canvas-darwin-arm64 missing/);
  assert.match(native.en, /found: @napi-rs\/canvas-linux-x64-gnu; this backend was built for linux-x64/);
  assert.match(native.zh, /默认图标/);
  assert.match(native.fix.en, /npm run build/);
  assert.deepEqual(calls[0].plan.ready, []);
  assert.equal(byId(report, "canvas-load").status, "skip");
});

test("runDoctor checks name, version, os/cpu and binary of every requested target", (t) => {
  const pluginDir = makePluginDir(t, {
    targets: ["darwin-arm64"],
    packages: [
      nativePackage("darwin-x64", { version: "0.1.99" }),
      nativePackage("win32-x64", { cpu: ["arm64"] }),
    ],
  });
  const report = runDoctor({
    pluginDir,
    env: { FLEX_TARGET: "all" },
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: true, target: "darwin-arm64" }),
  });

  assert.equal(report.ok, false);
  const [arm64, x64, win] = allById(report, "canvas-native");
  assert.equal(arm64.status, "pass");
  assert.equal(x64.status, "fail");
  assert.match(x64.en, /found @napi-rs\/canvas-darwin-x64@0\.1\.99, expected @napi-rs\/canvas-darwin-x64@0\.1\.100/);
  assert.equal(win.status, "fail");
  assert.match(win.en, /targets win32-arm64, not win32-x64/);
  assert.equal(x64.fix.en.includes("`FLEX_TARGET=all npm run build`"), true);
  assert.equal(x64.fix.en.includes("`$env:FLEX_TARGET='all'; npm run build`"), true);
  assert.equal(byId(report, "canvas-load").status, "pass");

  const emptyBinary = runDoctor({
    pluginDir: makePluginDir(t, { packages: [nativePackage("darwin-arm64", { binary: "" })] }),
    env: {},
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: false, skipped: "not-ready", target: "darwin-arm64" }),
  });
  assert.match(byId(emptyBinary, "canvas-native").en, /native binary skia\.darwin-arm64\.node is missing or empty/);
});

test("runDoctor requires every file a native package lists, like the build (icudtl.dat for Windows)", (t) => {
  const windows = nativePackage("win32-x64", { files: ["skia.win32-x64-msvc.node", "icudtl.dat"] });
  const pluginDir = makePluginDir(t, { targets: ["darwin-arm64"], packages: [windows] });
  const windowsDir = path.join(pluginDir, "backend", "node_modules", "@napi-rs", "canvas-win32-x64-msvc");
  const doctor = () => runDoctor({
    pluginDir,
    env: { FLEX_TARGET: "darwin-arm64,win32-x64" },
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: true, target: "darwin-arm64" }),
  });

  // The build refuses the same package, so the doctor never passes what bundleNativeCanvas would reject.
  assert.throws(
    () => nativeCanvas.assertNativePackage(windowsDir, windows.name, CANVAS_VERSION, "win32-x64"),
    /incomplete, missing icudtl\.dat/
  );
  const incomplete = doctor();
  assert.equal(incomplete.ok, false);
  const [arm64, win] = allById(incomplete, "canvas-native");
  assert.equal(arm64.status, "pass");
  assert.equal(win.status, "fail");
  assert.equal(win.target, "win32-x64");
  assert.match(win.en, /@napi-rs\/canvas-win32-x64-msvc is incomplete, missing icudtl\.dat/);
  assert.match(win.zh, /缺少 icudtl\.dat/);
  assert.equal(win.fix.en.includes("`FLEX_TARGET=darwin-arm64,win32-x64 npm run build`"), true);

  fs.writeFileSync(path.join(windowsDir, "icudtl.dat"), "icu");
  nativeCanvas.assertNativePackage(windowsDir, windows.name, CANVAS_VERSION, "win32-x64");
  const complete = doctor();
  assert.equal(complete.ok, true, statuses(complete).join(" "));
  assert.deepEqual(allById(complete, "canvas-native").map((item) => item.status), ["pass", "pass"]);
});

test("runDoctor reports unsupported FLEX_TARGET values like the build and skips the load test", (t) => {
  const pluginDir = makePluginDir(t, { targets: ["darwin-arm64"] });
  const report = runDoctor({
    pluginDir,
    env: { FLEX_TARGET: "darwin-arm64,beos-x64" },
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => assert.fail("loader must not run for an unsupported target"),
  });

  assert.equal(report.ok, false);
  const target = byId(report, "flex-target");
  assert.equal(target.status, "fail");
  assert.match(target.en, /^Unsupported target: Unknown FLEX_TARGET entry "beos-x64"\. Use one of: all, darwin, win32, host, darwin-arm64/);
  assert.match(target.fix.en, /FLEX_TARGET=all npm run build/);
  assert.equal(byId(report, "canvas-load"), undefined);
  assert.match(formatReport(report), /Target \/ 目标平台: unsupported FLEX_TARGET "darwin-arm64,beos-x64"/);
});

test("runDoctor fails a host build that FlexDesigner on this Mac cannot load (x64 Node.js on Apple silicon)", (t) => {
  const pluginDir = makePluginDir(t, { targets: ["darwin-x64"] });
  const report = runDoctor({
    pluginDir,
    env: {},
    platform: "darwin",
    arch: "x64",
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: false, skipped: "not-requested", target: "darwin-arm64", node: "22.22.0", electron: "38.8.6" }),
  });

  assert.equal(report.ok, false);
  const load = byId(report, "canvas-load");
  assert.equal(load.status, "fail");
  assert.match(load.en, /needs the darwin-arm64 binary, but this build only bundles darwin-x64/);
  assert.match(load.fix.en, /`FLEX_TARGET=darwin-arm64 npm run plugin:install`/);
  assert.match(load.fix.en, /PowerShell/);
});

test("runDoctor only warns when FLEX_TARGET deliberately leaves out this machine's FlexDesigner", (t) => {
  const pluginDir = makePluginDir(t, { targets: ["win32-x64"] });
  const report = runDoctor({
    pluginDir,
    env: { FLEX_TARGET: "win32-x64" },
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: false, skipped: "not-requested", target: "darwin-arm64" }),
  });

  assert.equal(report.ok, true, statuses(report).join(" "));
  const load = byId(report, "canvas-load");
  assert.equal(load.status, "warn");
  assert.match(load.en, /FLEX_TARGET=win32-x64 does not include/);
  assert.match(load.en, /do not install this build here/);
});

test("runDoctor warns when this Node.js has a different arch than the loaded binary", (t) => {
  const pluginDir = makePluginDir(t, { targets: ["darwin-arm64", "darwin-x64"] });
  const report = runDoctor({
    pluginDir,
    env: { FLEX_TARGET: "darwin" },
    platform: "darwin",
    arch: "x64",
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: true, target: "darwin-arm64", node: "22.22.0" }),
  });

  assert.equal(report.ok, true);
  const warning = byId(report, "runtime-arch");
  assert.equal(warning.status, "warn");
  assert.match(warning.en, /This Node\.js runs as darwin-x64, but the plugin runtime loads the darwin-arm64 binary/);
  assert.match(warning.fix.en, /FLEX_TARGET including darwin-arm64/);
});

test("resolveLoadRuntime prefers FLEX_NODE_RUNTIME, then FlexDesigner's helper on macOS, then this Node.js", (t) => {
  const helper = path.join(tempDir(t), "FlexDesigner Helper");
  fs.writeFileSync(helper, "");
  const missing = path.join(path.dirname(helper), "missing Helper");

  assert.deepEqual(
    resolveLoadRuntime({ env: { FLEX_NODE_RUNTIME: "/opt/node/bin/node" }, platform: "darwin", flexDesignerRuntime: helper }),
    { path: "/opt/node/bin/node", kind: "override" }
  );
  assert.deepEqual(resolveLoadRuntime({ env: {}, platform: "darwin", flexDesignerRuntime: helper }), { path: helper, kind: "flexdesigner" });
  assert.deepEqual(
    resolveLoadRuntime({ env: {}, platform: "darwin", execPath: "/usr/local/bin/node", flexDesignerRuntime: missing }),
    { path: "/usr/local/bin/node", kind: "node", missing }
  );
  assert.deepEqual(
    resolveLoadRuntime({ env: {}, platform: "win32", execPath: "C:\\node\\node.exe", flexDesignerRuntime: helper }),
    { path: "C:\\node\\node.exe", kind: "node" }
  );

  const report = runDoctor({
    pluginDir: makePluginDir(t, { targets: ["darwin-arm64"] }),
    env: {},
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    execPath: "/usr/local/bin/node",
    flexDesignerRuntime: missing,
    loadCanvas: (dir, plan, runtime) => ({ ok: true, target: "darwin-arm64", node: "20.18.0", runtime }),
  });
  assert.equal(report.ok, true);
  const warning = byId(report, "load-runtime");
  assert.equal(warning.status, "warn");
  assert.match(warning.en, /FlexDesigner was not found at .*missing Helper, so the canvas load test uses this Node\.js/);
  assert.match(byId(report, "canvas-load").en, /loads in this Node\.js \(darwin-arm64, Node 20\.18\.0\)/);
});

test("runDoctor reports a canvas load failure and an unusable runtime", (t) => {
  const pluginDir = makePluginDir(t, { targets: ["darwin-arm64"] });
  const failed = runDoctor({
    pluginDir,
    env: {},
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: false, target: "darwin-arm64", error: "Cannot find native binding." }),
  });
  assert.equal(failed.ok, false);
  const load = byId(failed, "canvas-load");
  assert.equal(load.status, "fail");
  assert.match(load.en, /Cannot find native binding/);
  assert.match(load.fix.en, /^Delete com\.example\.demo\.plugin\/backend, then rebuild on this machine: `npm install && npm run build`\./);

  const runtime = { path: path.join(tempDir(t), "no-such-node"), kind: "override" };
  const broken = runDoctor({ pluginDir, env: {}, ...DARWIN_ARM64, nodeVersion: "20.18.0", runtime, loadCanvas: loadCanvasInChild });
  const start = byId(broken, "canvas-load");
  assert.equal(start.status, "fail");
  assert.match(start.en, /Could not start the load-test runtime .*no-such-node/);
  assert.match(start.fix.en, /FLEX_NODE_RUNTIME/);
});

test("runDoctor warns about config.json and pack backups in the source plugin folder only", (t) => {
  const source = makePluginDir(t, { targets: ["darwin-arm64"], config: { codexHome: "/Users/me/.codex" } });
  const options = { env: {}, ...DARWIN_ARM64, nodeVersion: "20.18.0", runtime: FLEXDESIGNER, loadCanvas: () => ({ ok: true, target: "darwin-arm64" }) };
  const report = runDoctor({ ...options, pluginDir: source });
  assert.equal(report.ok, true);
  const config = byId(report, "config-json");
  assert.equal(config.status, "warn");
  assert.match(config.en, /`npm run plugin:pack` keeps it out of the \.flexplugin/);

  fs.writeFileSync(configBackupPath(source), "{}");
  const both = runDoctor({ ...options, pluginDir: source });
  assert.equal(byId(both, "config-backup").status, "warn");
  assert.match(byId(both, "config-backup").fix.en, /packing refuses to run while both exist/);

  fs.rmSync(path.join(source, "config.json"));
  const stranded = runDoctor({ ...options, pluginDir: source });
  assert.match(byId(stranded, "config-backup").fix.en, /next `npm run plugin:pack` restores it/);
  assert.equal(byId(stranded, "config-json"), undefined);

  const installed = makePluginDir(t, { folder: "com.example.demo", targets: ["darwin-arm64"], config: {} });
  const installedReport = runDoctor({ ...options, pluginDir: installed });
  assert.equal(byId(installedReport, "config-json"), undefined);
  assert.equal(installedReport.checks.filter((item) => item.status === "warn").length, 0);
});

test("runDoctor validates manifest JSON, uuid/folder match and the built entry", (t) => {
  const options = { env: {}, ...DARWIN_ARM64, nodeVersion: "20.18.0", runtime: FLEXDESIGNER, loadCanvas: () => ({ ok: true, target: "darwin-arm64" }) };
  const badJson = runDoctor({ ...options, pluginDir: makePluginDir(t, { manifest: "{ not json" }) });
  assert.equal(byId(badJson, "manifest").status, "fail");
  assert.match(byId(badJson, "manifest").en, /not valid JSON/);

  const mismatch = runDoctor({ ...options, pluginDir: makePluginDir(t, { folder: "com.other.name.plugin" }) });
  assert.equal(byId(mismatch, "manifest").status, "fail");
  assert.match(byId(mismatch, "manifest").en, /expected "com\.example\.demo\.plugin"/);

  const installedLayout = runDoctor({ ...options, pluginDir: makePluginDir(t, { folder: "com.example.demo", targets: ["darwin-arm64"] }) });
  assert.equal(byId(installedLayout, "manifest").status, "pass");
  assert.equal(installedLayout.ok, true);

  const unbuilt = runDoctor({ ...options, pluginDir: makePluginDir(t, { entry: "", withCanvas: false }) });
  assert.equal(byId(unbuilt, "backend-entry").status, "fail");
  assert.match(byId(unbuilt, "backend-entry").fix.en, /npm run build/);
  assert.equal(byId(unbuilt, "canvas-js").status, "fail");
  assert.equal(byId(unbuilt, "canvas-native").status, "skip");
});

test("formatReport prints bilingual results, fixes and a summary line", (t) => {
  const failing = runDoctor({
    pluginDir: makePluginDir(t, { targets: ["linux-x64"] }),
    env: {},
    ...DARWIN_ARM64,
    nodeVersion: "25.9.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: false, skipped: "not-ready", target: "darwin-arm64" }),
  });
  const text = formatReport(failing);
  assert.match(text, /Target \/ 目标平台: darwin-arm64 \(this machine \/ 本机\), Node\.js v25\.9\.0/);
  assert.match(text, /^\[WARN\] A plain `flexcli`/m);
  assert.match(text, /^\[FAIL\] Native canvas for darwin-arm64: @napi-rs\/canvas-darwin-arm64 missing/m);
  assert.match(text, /^ {7}Fix: Rebuild on this machine: `npm install && npm run build`\./m);
  assert.match(text, /^ {7}修复：在本机重新构建/m);
  assert.match(text, /^FAILED: 1 check\(s\) failed\./m);
  assert.match(text, /^失败：1 项检查未通过/m);

  const passing = runDoctor({
    pluginDir: makePluginDir(t, { targets: ["darwin-arm64", "darwin-x64"] }),
    env: { FLEX_TARGET: "darwin" },
    ...DARWIN_ARM64,
    nodeVersion: "20.18.0",
    runtime: FLEXDESIGNER,
    loadCanvas: () => ({ ok: true, target: "darwin-arm64" }),
  });
  const ok = formatReport(passing);
  assert.match(ok, /Target \/ 目标平台: darwin-arm64, darwin-x64 \(FLEX_TARGET=darwin\)/);
  assert.match(ok, /^OK: 8 passed, 0 warning\(s\)\. Ready to pack and install\.$/m);
  assert.doesNotMatch(ok, /Fix:/);
});

test("parseArgs supports --json and --plugin-dir and rejects unknown flags", () => {
  assert.deepEqual(parseArgs([]), { json: false });
  assert.deepEqual(parseArgs(["--json", "--plugin-dir=/tmp/x.plugin"]), { json: true, pluginDir: "/tmp/x.plugin" });
  assert.throws(() => parseArgs(["--fix"]), /Unknown argument: --fix/);
});

// Regression: the child used to compare Module._nodeModulePaths against path.resolve(pluginDir), but Node
// realpaths module filenames, so a plugin under a symlink (/tmp, $TMPDIR = /var -> /private/var on macOS,
// symlinked workspaces) failed with "Cannot find native binding" although it was complete.
test("the load test works for a plugin folder reached through a symlink", (t) => {
  const host = nativeCanvas.hostCanvasTarget();
  const nativeName = host && nativeCanvas.nativeCanvasPackageName(host);
  const sourceModules = path.join(repoRoot, "node_modules");
  if (!host || !fs.existsSync(path.join(sourceModules, ...nativeName.split("/"), "package.json"))) {
    t.skip(`no installed ${nativeName || "native canvas package"} for ${process.platform}-${process.arch}`);
    return;
  }

  const root = tempDir(t);
  const realRoot = path.join(root, "real");
  const pluginDir = path.join(realRoot, "com.example.demo.plugin");
  for (const name of [nativeCanvas.CANVAS_PACKAGE, nativeName]) {
    fs.cpSync(path.join(sourceModules, ...name.split("/")), path.join(pluginDir, "backend", "node_modules", ...name.split("/")), {
      recursive: true,
      dereference: true,
    });
  }
  const link = path.join(root, "link");
  fs.symlinkSync(realRoot, link, process.platform === "win32" ? "junction" : "dir");
  const linkedPluginDir = path.join(link, "com.example.demo.plugin");
  assert.notEqual(fs.realpathSync(linkedPluginDir), path.resolve(linkedPluginDir));

  const outcome = loadCanvasInChild(
    linkedPluginDir,
    { requested: { [host]: nativeName }, ready: [host] },
    { path: process.execPath, kind: "node" }
  );

  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.target, host);
  assert.ok(outcome.pngBytes > 0);
  assert.ok(outcome.binding.startsWith(fs.realpathSync(pluginDir) + path.sep), outcome.binding);
});
