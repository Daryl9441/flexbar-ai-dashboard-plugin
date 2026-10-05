"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DESKTOP_TARGETS,
  NATIVE_CANVAS_TARGETS,
  bundleNativeCanvas,
  extractNpmTarball,
  fetchNativePackage,
  hostCanvasTarget,
  nativeCanvasPackageName,
  resolveCanvasTargets,
} = require("../scripts/native-canvas.cjs");
const { RELEASE_ASSETS, releaseAssetFileName } = require("../scripts/pack-release.cjs");

const CANVAS_VERSION = "9.8.7";

test("an empty FLEX_TARGET bundles only the build host binary", () => {
  assert.deepEqual(resolveCanvasTargets(undefined, { platform: "darwin", arch: "arm64" }), ["darwin-arm64"]);
  assert.deepEqual(resolveCanvasTargets("", { platform: "win32", arch: "x64" }), ["win32-x64"]);
  assert.deepEqual(resolveCanvasTargets("  ", { platform: "linux", arch: "x64" }), ["linux-x64"]);
});

test("FLEX_TARGET accepts lists, aliases, package suffixes and package names", () => {
  const host = { platform: "linux", arch: "x64" };

  assert.deepEqual(resolveCanvasTargets("all", host), ["darwin-arm64", "darwin-x64", "win32-x64"]);
  assert.deepEqual(resolveCanvasTargets("darwin", host), ["darwin-arm64", "darwin-x64"]);
  assert.deepEqual(resolveCanvasTargets("win32", host), ["win32-x64"]);
  assert.deepEqual(resolveCanvasTargets("darwin-arm64, win32-x64-msvc", host), ["darwin-arm64", "win32-x64"]);
  assert.deepEqual(resolveCanvasTargets("@napi-rs/canvas-darwin-x64 HOST", host), ["darwin-x64", "linux-x64"]);
  assert.deepEqual(resolveCanvasTargets("darwin-x64,all,darwin", host), ["darwin-x64", "darwin-arm64", "win32-x64"]);
});

test("FLEX_TARGET rejects unknown targets and unsupported hosts", () => {
  assert.throws(
    () => resolveCanvasTargets("darwin-arm64,freebsd-x64", { platform: "darwin", arch: "arm64" }),
    /Unknown FLEX_TARGET entry "freebsd-x64"/
  );
  assert.throws(() => resolveCanvasTargets("", { platform: "freebsd", arch: "x64" }), /freebsd-x64/);
  assert.throws(() => resolveCanvasTargets("host", { platform: "sunos", arch: "x64" }), /sunos-x64/);
});

test("host targets map to the published @napi-rs/canvas native packages", () => {
  const expected = {
    "win32:x64": "@napi-rs/canvas-win32-x64-msvc",
    "win32:arm64": "@napi-rs/canvas-win32-arm64-msvc",
    "darwin:x64": "@napi-rs/canvas-darwin-x64",
    "darwin:arm64": "@napi-rs/canvas-darwin-arm64",
    "linux:x64": "@napi-rs/canvas-linux-x64-gnu",
    "linux:arm64": "@napi-rs/canvas-linux-arm64-gnu",
    "linux:arm": "@napi-rs/canvas-linux-arm-gnueabihf",
    "android:arm64": "@napi-rs/canvas-android-arm64",
  };
  for (const [key, packageName] of Object.entries(expected)) {
    const [platform, arch] = key.split(":");
    assert.equal(nativeCanvasPackageName(hostCanvasTarget(platform, arch)), packageName, key);
  }
  assert.equal(hostCanvasTarget("win32", "ia32"), null);
  assert.deepEqual(DESKTOP_TARGETS, ["darwin-arm64", "darwin-x64", "win32-x64"]);
});

test("every known target is published by the installed @napi-rs/canvas", () => {
  const canvasPackage = require("@napi-rs/canvas/package.json");
  for (const target of Object.keys(NATIVE_CANVAS_TARGETS)) {
    const name = nativeCanvasPackageName(target);
    assert.equal(canvasPackage.optionalDependencies[name], canvasPackage.version, name);
  }
});

test("bundling copies requested binaries, fetches missing ones at the canvas version and drops stale ones", (t) => {
  const { projectDir, pluginDir, cacheDir } = createFixture(t);
  writeNativePackage(installedDir(projectDir, "darwin-arm64"), "darwin-arm64", CANVAS_VERSION);
  writeNativePackage(installedDir(projectDir, "darwin-x64"), "darwin-x64", "9.8.6");
  writeNativePackage(backendDir(pluginDir, "linux-x64"), "linux-x64", CANVAS_VERSION);

  const fetched = [];
  const bundled = bundleNativeCanvas({
    projectDir,
    pluginDir,
    cacheDir,
    targets: ["darwin-arm64", "darwin-x64", "win32-x64"],
    fetchPackage: ({ name, version, cacheDir: cache }) => {
      fetched.push(`${name}@${version}`);
      const target = Object.keys(NATIVE_CANVAS_TARGETS).find((key) => nativeCanvasPackageName(key) === name);
      const dir = path.join(cache, name.replace("/", "+"));
      writeNativePackage(dir, target, version);
      return dir;
    },
  });

  assert.deepEqual(fetched, ["@napi-rs/canvas-darwin-x64@9.8.7", "@napi-rs/canvas-win32-x64-msvc@9.8.7"]);
  assert.deepEqual(bundled.map((item) => [item.target, item.source, item.version]), [
    ["darwin-arm64", "node_modules", CANVAS_VERSION],
    ["darwin-x64", "npm pack", CANVAS_VERSION],
    ["win32-x64", "npm pack", CANVAS_VERSION],
  ]);
  assert.deepEqual(fs.readdirSync(path.join(pluginDir, "backend", "node_modules", "@napi-rs")).sort(), [
    "canvas",
    "canvas-darwin-arm64",
    "canvas-darwin-x64",
    "canvas-win32-x64-msvc",
  ]);
  for (const item of bundled) {
    assert.ok(item.binary.startsWith(path.join(pluginDir, "backend", "node_modules")), item.binary);
    assert.ok(fs.existsSync(item.binary), item.binary);
  }
});

test("bundling fails loudly when a requested binary cannot be bundled", (t) => {
  const { projectDir, pluginDir, cacheDir } = createFixture(t);
  const bundle = (fetchPackage, targets = ["win32-x64"]) =>
    bundleNativeCanvas({ projectDir, pluginDir, cacheDir, targets, fetchPackage });

  assert.throws(() => bundle(() => { throw new Error("npm pack failed: offline"); }), /offline/);
  assert.throws(
    () => bundle(() => writeNativePackage(path.join(cacheDir, "old"), "win32-x64", "9.8.6")),
    /expected @napi-rs\/canvas-win32-x64-msvc@9\.8\.7/
  );
  assert.throws(
    () => bundle(() => writeNativePackage(path.join(cacheDir, "wrong-cpu"), "win32-x64", CANVAS_VERSION, { cpu: ["arm64"] })),
    /expected x64/
  );
  assert.throws(
    () => bundle(() => writeNativePackage(path.join(cacheDir, "no-binary"), "win32-x64", CANVAS_VERSION, { binary: false })),
    /binary for win32-x64 is missing/
  );
  assert.throws(() => bundle(() => assert.fail("not fetched"), []), /No native canvas targets/);
});

test("bundling requires @napi-rs/canvas and a target it publishes", (t) => {
  const { projectDir, pluginDir, cacheDir } = createFixture(t, { optionalDependencies: {} });
  assert.throws(
    () => bundleNativeCanvas({ projectDir, pluginDir, cacheDir, targets: ["darwin-arm64"] }),
    /does not publish @napi-rs\/canvas-darwin-arm64/
  );

  fs.rmSync(path.join(projectDir, "node_modules"), { recursive: true, force: true });
  assert.throws(
    () => bundleNativeCanvas({ projectDir, pluginDir, cacheDir, targets: ["darwin-arm64"] }),
    /run npm install/
  );
});

test("fetching uses npm pack once, extracts the tarball and reuses the cache", (t) => {
  const { cacheDir } = createFixture(t);
  const name = "@napi-rs/canvas-darwin-x64";
  const calls = [];
  const runNpm = (args, options) => {
    calls.push(args);
    const destination = args[args.indexOf("--pack-destination") + 1];
    fs.writeFileSync(
      path.join(destination, "napi-rs-canvas-darwin-x64-9.8.7.tgz"),
      createTarball({
        "package/package.json": JSON.stringify(nativePackageJson("darwin-x64", CANVAS_VERSION)),
        "package/skia.darwin-x64.node": "binary",
      })
    );
    assert.equal(options.cwd, "/project");
  };

  const first = fetchNativePackage({ name, version: CANVAS_VERSION, cacheDir, projectDir: "/project", runNpm });
  const second = fetchNativePackage({ name, version: CANVAS_VERSION, cacheDir, projectDir: "/project", runNpm });

  assert.equal(first, second);
  assert.deepEqual(calls, [["pack", `${name}@${CANVAS_VERSION}`, "--pack-destination", calls[0][3], "--loglevel=error"]]);
  assert.equal(fs.readFileSync(path.join(first, "skia.darwin-x64.node"), "utf8"), "binary");
  assert.deepEqual(fs.readdirSync(cacheDir), [path.basename(first)]);
});

test("tarball extraction refuses entries outside the destination", (t) => {
  const { cacheDir } = createFixture(t);
  const tarball = path.join(cacheDir, "evil.tgz");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(tarball, createTarball({ "package/../../escape.txt": "nope" }));

  assert.throws(() => extractNpmTarball(tarball, path.join(cacheDir, "out")), /outside/);
  assert.equal(fs.existsSync(path.join(cacheDir, "..", "escape.txt")), false);
});

test("release assets follow FlexDesigner's <os>.<arch> naming and work whichever OS asset it picks", () => {
  const uuid = "com.aspen.flexbar-ai-dashboard";
  const assets = RELEASE_ASSETS.map((asset) => ({ name: releaseAssetFileName(uuid, asset), targets: asset.targets }));

  assert.deepEqual(assets.map((asset) => asset.name), [
    "com.aspen.flexbar-ai-dashboard.darwin.arm64.flexplugin",
    "com.aspen.flexbar-ai-dashboard.darwin.x64.flexplugin",
    "com.aspen.flexbar-ai-dashboard.win32.x64.flexplugin",
    "com.aspen.flexbar-ai-dashboard.flexplugin",
  ]);

  // Patterns FlexDesigner 2.2.x matches release assets against (os aliases first, then os + exact arch).
  const osAliases = { darwin: ["darwin", "mac", "macos", "osx"], win32: ["win32", "windows", "win"] };
  for (const target of DESKTOP_TARGETS) {
    const [platform, arch] = target.split("-");
    const aliasPatterns = osAliases[platform].map((alias) => new RegExp(`\\.${alias}\\.(x64|arm64)?\\.flexplugin$`, "i"));
    const exactPattern = new RegExp(`\\.(${osAliases[platform].join("|")})\\.${arch}\\.flexplugin$`, "i");
    const candidates = assets.filter((asset) => [...aliasPatterns, exactPattern].some((pattern) => pattern.test(asset.name)));

    assert.ok(assets.some((asset) => exactPattern.test(asset.name)), `${target} has an exact asset`);
    assert.ok(candidates.length > 0, `${target} has an OS-specific asset`);
    for (const asset of candidates) {
      assert.ok(asset.targets.includes(target), `${asset.name} must bundle ${target}`);
    }
  }

  const generic = assets.find((asset) => !/\.(darwin|win32|linux)\./.test(asset.name));
  assert.deepEqual([...generic.targets].sort(), [...DESKTOP_TARGETS].sort());
});

function createFixture(t, canvasOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-canvas-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "project");
  const pluginDir = path.join(projectDir, "example.plugin");
  const canvasDir = path.join(projectDir, "node_modules", "@napi-rs", "canvas");
  const optionalDependencies = Object.fromEntries(
    Object.keys(NATIVE_CANVAS_TARGETS).map((target) => [nativeCanvasPackageName(target), CANVAS_VERSION])
  );
  fs.mkdirSync(canvasDir, { recursive: true });
  fs.writeFileSync(path.join(canvasDir, "index.js"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(canvasDir, "package.json"),
    JSON.stringify({ name: "@napi-rs/canvas", version: CANVAS_VERSION, optionalDependencies, ...canvasOverrides })
  );
  return { projectDir, pluginDir, cacheDir: path.join(root, "cache") };
}

function installedDir(projectDir, target) {
  return path.join(projectDir, "node_modules", ...nativeCanvasPackageName(target).split("/"));
}

function backendDir(pluginDir, target) {
  return path.join(pluginDir, "backend", "node_modules", ...nativeCanvasPackageName(target).split("/"));
}

function nativePackageJson(target, version, overrides = {}) {
  const [platform, arch] = target.split("-");
  const suffix = NATIVE_CANVAS_TARGETS[target];
  return { name: nativeCanvasPackageName(target), version, os: [platform], cpu: [arch], main: `skia.${suffix}.node`, ...overrides };
}

function writeNativePackage(dir, target, version, { binary = true, ...overrides } = {}) {
  const packageJson = nativePackageJson(target, version, overrides);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson));
  if (binary) fs.writeFileSync(path.join(dir, packageJson.main), "binary");
  return dir;
}

function createTarball(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}
