"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkFlexcliRuntime,
  checkNodeVersion,
  expectedCanvasPackages,
  formatReport,
  parseArgs,
  parseTarget,
  resolveTarget,
  runDoctor,
  targetForCanvasPackage,
} = require("../scripts/doctor.cjs");

function makePluginDir({ folder = "com.example.demo.plugin", manifest, nativePackages = [], withCanvas = true, entry = "bundle" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-doctor-"));
  const pluginDir = path.join(root, folder);
  fs.mkdirSync(path.join(pluginDir, "backend"), { recursive: true });
  const manifestText = manifest === undefined
    ? JSON.stringify({ uuid: "com.example.demo", entry: "backend/plugin.cjs" })
    : manifest;
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), manifestText, "utf8");
  if (entry) fs.writeFileSync(path.join(pluginDir, "backend", "plugin.cjs"), entry, "utf8");
  const packages = withCanvas ? ["@napi-rs/canvas", ...nativePackages] : nativePackages;
  for (const name of packages) {
    const dir = path.join(pluginDir, "backend", "node_modules", ...name.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }), "utf8");
  }
  return pluginDir;
}

function byId(report, id) {
  return report.checks.find((item) => item.id === id);
}

test("parseTarget accepts platform-arch pairs and common aliases", () => {
  assert.deepEqual(parseTarget("darwin-arm64"), { platform: "darwin", arch: "arm64", id: "darwin-arm64" });
  assert.deepEqual(parseTarget("darwin.arm64"), { platform: "darwin", arch: "arm64", id: "darwin-arm64" });
  assert.equal(parseTarget("mac-x86_64").id, "darwin-x64");
  assert.equal(parseTarget("Windows-AMD64").id, "win32-x64");
  assert.equal(parseTarget("linux/aarch64").id, "linux-arm64");
  assert.equal(parseTarget("darwin"), null);
  assert.equal(parseTarget("beos-x64"), null);
  assert.equal(parseTarget(""), null);
});

test("resolveTarget uses the host unless FLEX_TARGET is set", () => {
  const host = resolveTarget({ env: {}, platform: "darwin", arch: "arm64" });
  assert.equal(host.id, "darwin-arm64");
  assert.equal(host.source, "host");

  const cross = resolveTarget({ env: { FLEX_TARGET: "win32-x64" }, platform: "darwin", arch: "arm64" });
  assert.equal(cross.id, "win32-x64");
  assert.equal(cross.source, "FLEX_TARGET");
  assert.equal(cross.host.id, "darwin-arm64");

  const invalid = resolveTarget({ env: { FLEX_TARGET: "nope" }, platform: "darwin", arch: "arm64" });
  assert.equal(invalid.id, null);
  assert.equal(invalid.invalid, "nope");
});

test("expectedCanvasPackages maps each target to its @napi-rs/canvas native package", () => {
  assert.equal(expectedCanvasPackages(parseTarget("darwin-arm64"))[0], "@napi-rs/canvas-darwin-arm64");
  assert.equal(expectedCanvasPackages(parseTarget("darwin-x64"))[0], "@napi-rs/canvas-darwin-x64");
  assert.equal(expectedCanvasPackages(parseTarget("win32-x64"))[0], "@napi-rs/canvas-win32-x64-msvc");
  assert.equal(expectedCanvasPackages(parseTarget("linux-x64"))[0], "@napi-rs/canvas-linux-x64-gnu");
  assert.deepEqual(expectedCanvasPackages({ id: "sunos-x64" }), []);
  assert.equal(targetForCanvasPackage("@napi-rs/canvas-linux-x64-gnu"), "linux-x64");
  assert.equal(targetForCanvasPackage("@napi-rs/canvas"), null);
});

test("every native canvas package copied by rollup is known to the doctor", () => {
  const rollupConfig = fs.readFileSync(path.join(__dirname, "..", "rollup.config.mjs"), "utf8");
  const copied = [...new Set(rollupConfig.match(/@napi-rs\/canvas-[a-z0-9-]+/g) || [])];

  assert.ok(copied.length > 0);
  for (const name of copied) {
    assert.notEqual(targetForCanvasPackage(name), null, `${name} is not mapped in scripts/doctor.cjs`);
  }
});

test("checkNodeVersion requires Node.js 18 or later", () => {
  assert.equal(checkNodeVersion("16.20.2").status, "fail");
  assert.equal(checkNodeVersion("18.0.0").status, "pass");
  assert.equal(checkNodeVersion("v25.9.0").status, "pass");
});

test("checkFlexcliRuntime warns that a plain flexcli 1.0.7 breaks on Node.js 22+", () => {
  assert.equal(checkFlexcliRuntime("20.18.0").status, "pass");
  const warning = checkFlexcliRuntime("22.22.0");
  assert.equal(warning.status, "warn");
  assert.match(warning.en, /Unexpected identifier 'assert'/);
  assert.match(warning.fix.en, /scripts\/flexcli\.cjs/);
});

test("runDoctor fails when the backend only has another platform's canvas binary", () => {
  const pluginDir = makePluginDir({ nativePackages: ["@napi-rs/canvas-linux-x64-gnu"] });
  let loaderCalls = 0;
  const report = runDoctor({
    pluginDir,
    env: {},
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "20.18.0",
    loadCanvas: () => {
      loaderCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(report.ok, false);
  const native = byId(report, "canvas-native");
  assert.equal(native.status, "fail");
  assert.match(native.en, /@napi-rs\/canvas-darwin-arm64/);
  assert.match(native.en, /found: @napi-rs\/canvas-linux-x64-gnu/);
  assert.match(native.en, /built on linux-x64/);
  assert.match(native.zh, /默认图标/);
  assert.equal(byId(report, "canvas-load").status, "skip");
  assert.equal(loaderCalls, 0);
});

test("runDoctor passes and runs the load test when the host binary is bundled", () => {
  const pluginDir = makePluginDir({ nativePackages: ["@napi-rs/canvas-darwin-arm64"] });
  const calls = [];
  const report = runDoctor({
    pluginDir,
    env: {},
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "20.18.0",
    loadCanvas: (dir, candidates) => {
      calls.push({ dir, candidates });
      return { ok: true, binding: path.join(dir, "backend", "node_modules", "@napi-rs", "canvas-darwin-arm64", "skia.node") };
    },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((item) => item.status), ["pass", "pass", "pass", "pass", "pass", "pass", "pass"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dir, pluginDir);
  assert.equal(calls[0].candidates[0], "@napi-rs/canvas-darwin-arm64");
});

test("runDoctor reports a canvas load failure from the child process", () => {
  const pluginDir = makePluginDir({ nativePackages: ["@napi-rs/canvas-darwin-arm64"] });
  const report = runDoctor({
    pluginDir,
    env: {},
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "20.18.0",
    loadCanvas: () => ({ ok: false, error: "Cannot find native binding." }),
  });

  assert.equal(report.ok, false);
  const load = byId(report, "canvas-load");
  assert.equal(load.status, "fail");
  assert.match(load.en, /Cannot find native binding/);
});

test("runDoctor skips the load test for a FLEX_TARGET other than the host", () => {
  const pluginDir = makePluginDir({ nativePackages: ["@napi-rs/canvas-win32-x64-msvc"] });
  const report = runDoctor({
    pluginDir,
    env: { FLEX_TARGET: "win32-x64" },
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "20.18.0",
    loadCanvas: () => assert.fail("loader must not run for a cross target"),
  });

  assert.equal(report.ok, true);
  assert.equal(byId(report, "canvas-native").status, "pass");
  assert.equal(byId(report, "canvas-load").status, "skip");
});

test("runDoctor validates manifest JSON, uuid/folder match and the built entry", () => {
  const badJson = runDoctor({ pluginDir: makePluginDir({ manifest: "{ not json" }), env: {}, loadCanvas: () => ({ ok: true }) });
  assert.equal(byId(badJson, "manifest").status, "fail");
  assert.match(byId(badJson, "manifest").en, /not valid JSON/);

  const mismatch = runDoctor({ pluginDir: makePluginDir({ folder: "com.other.name.plugin" }), env: {}, loadCanvas: () => ({ ok: true }) });
  assert.equal(byId(mismatch, "manifest").status, "fail");
  assert.match(byId(mismatch, "manifest").en, /expected "com\.example\.demo\.plugin"/);

  const installedLayout = runDoctor({
    pluginDir: makePluginDir({ folder: "com.example.demo", nativePackages: ["@napi-rs/canvas-darwin-arm64"] }),
    env: {},
    platform: "darwin",
    arch: "arm64",
    loadCanvas: () => ({ ok: true }),
  });
  assert.equal(byId(installedLayout, "manifest").status, "pass");

  const unbuilt = runDoctor({ pluginDir: makePluginDir({ entry: "", withCanvas: false }), env: {}, loadCanvas: () => ({ ok: true }) });
  assert.equal(byId(unbuilt, "backend-entry").status, "fail");
  assert.match(byId(unbuilt, "backend-entry").fix.en, /npm run build/);
  assert.equal(byId(unbuilt, "canvas-js").status, "fail");
});

test("formatReport prints bilingual results, fixes and a summary line", () => {
  const failing = runDoctor({
    pluginDir: makePluginDir({ nativePackages: ["@napi-rs/canvas-linux-x64-gnu"] }),
    env: {},
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "25.9.0",
    loadCanvas: () => ({ ok: true }),
  });
  const text = formatReport(failing);
  assert.match(text, /Target \/ 目标平台: darwin-arm64 \(this machine \/ 本机\), Node\.js v25\.9\.0/);
  assert.match(text, /^\[WARN\] A plain `flexcli`/m);
  assert.match(text, /^\[FAIL\] backend\/node_modules has no @napi-rs\/canvas-darwin-arm64/m);
  assert.match(text, /^ {7}Fix: Build on this machine/m);
  assert.match(text, /^ {7}修复：在本机构建/m);
  assert.match(text, /^FAILED: 1 check\(s\) failed\./m);
  assert.match(text, /^失败：1 项检查未通过/m);

  const passing = runDoctor({
    pluginDir: makePluginDir({ nativePackages: ["@napi-rs/canvas-darwin-arm64"] }),
    env: {},
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "20.18.0",
    loadCanvas: () => ({ ok: true }),
  });
  const ok = formatReport(passing);
  assert.match(ok, /^OK: 7 passed, 0 warning\(s\)\. Ready to pack and install\.$/m);
  assert.doesNotMatch(ok, /Fix:/);
});

test("parseArgs supports --json and --plugin-dir and rejects unknown flags", () => {
  assert.deepEqual(parseArgs([]), { json: false });
  assert.deepEqual(parseArgs(["--json", "--plugin-dir=/tmp/x.plugin"]), { json: true, pluginDir: "/tmp/x.plugin" });
  assert.throws(() => parseArgs(["--fix"]), /Unknown argument: --fix/);
});
