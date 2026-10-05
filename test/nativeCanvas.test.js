"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DESKTOP_TARGETS,
  NATIVE_CANVAS_TARGETS,
  assertNativePackage,
  bundleNativeCanvas,
  defaultCacheDir,
  extractNpmTarball,
  fetchNativePackage,
  hostCanvasTarget,
  lockfileIntegrity,
  nativeCanvasPackageName,
  resolveCanvasTargets,
} = require("../scripts/native-canvas.cjs");
const {
  RELEASE_ASSETS,
  inspectReleaseAsset,
  packRelease,
  readZipEntries,
  releaseAssetFileName,
  verifyReleaseDir,
} = require("../scripts/pack-release.cjs");

const CANVAS_VERSION = "9.8.7";
const UUID = "com.aspen.flexbar-ai-dashboard";

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

test("every desktop target is published by the installed @napi-rs/canvas", () => {
  const canvasPackage = require("@napi-rs/canvas/package.json");
  for (const target of DESKTOP_TARGETS) {
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
  const cleaned = [];
  const bundled = bundleNativeCanvas({
    projectDir,
    pluginDir,
    cacheDir,
    targets: ["darwin-arm64", "darwin-x64", "win32-x64"],
    fetchPackage: ({ name, version, target, cacheDir: cache }) => {
      fetched.push(`${name}@${version}`);
      const dir = writeNativePackage(path.join(cache, name.replace("/", "+")), target, version);
      return { dir, source: name.endsWith("x64") ? "cache" : "npm pack", cleanup: () => cleaned.push(name) };
    },
  });

  assert.deepEqual(fetched, ["@napi-rs/canvas-darwin-x64@9.8.7", "@napi-rs/canvas-win32-x64-msvc@9.8.7"]);
  assert.deepEqual(cleaned, ["@napi-rs/canvas-darwin-x64", "@napi-rs/canvas-win32-x64-msvc"]);
  assert.deepEqual(bundled.map((item) => [item.target, item.source, item.version, item.copy]), [
    ["darwin-arm64", "node_modules", CANVAS_VERSION, "copied"],
    ["darwin-x64", "cache", CANVAS_VERSION, "copied"],
    ["win32-x64", "npm pack", CANVAS_VERSION, "copied"],
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
  assert.ok(fs.existsSync(path.join(backendDir(pluginDir, "win32-x64"), "icudtl.dat")), "win32 icudtl.dat");
});

test("rebuilding with unchanged packages skips the copy without touching a locked binary", (t) => {
  const { projectDir, pluginDir, cacheDir } = createFixture(t);
  writeNativePackage(installedDir(projectDir, "win32-x64"), "win32-x64", CANVAS_VERSION);
  const bundle = (options = {}) =>
    bundleNativeCanvas({ projectDir, pluginDir, cacheDir, targets: ["win32-x64"], fetchPackage: () => assert.fail("not fetched"), ...options });

  assert.deepEqual(bundle().map((item) => item.copy), ["copied"]);

  const lockedFs = createLockedFs(pluginDir);
  const messages = [];
  const rebuilt = bundle({ fsApi: lockedFs, log: (message) => messages.push(message) });

  assert.deepEqual(rebuilt.map((item) => item.copy), ["unchanged"]);
  assert.deepEqual(lockedFs.writes, [], "nothing in the backend is written or removed");
  assert.ok(messages.some((message) => /@napi-rs\/canvas@9\.8\.7: unchanged, copy skipped/.test(message)), messages.join("\n"));
});

test("a changed binary that Windows keeps locked fails the build and leaves the bundled package whole", (t) => {
  const { projectDir, pluginDir, cacheDir } = createFixture(t);
  const installed = writeNativePackage(installedDir(projectDir, "win32-x64"), "win32-x64", CANVAS_VERSION);
  const bundle = (options = {}) =>
    bundleNativeCanvas({ projectDir, pluginDir, cacheDir, targets: ["win32-x64"], fetchPackage: () => assert.fail("not fetched"), ...options });
  bundle();

  // e.g. `npm install` replaced the binary while FlexDesigner runs the plugin
  fs.writeFileSync(path.join(installed, "skia.win32-x64-msvc.node"), "new binary");
  const lockedFs = createLockedFs(pluginDir);
  assert.throws(() => bundle({ fsApi: lockedFs }), /skia\.win32-x64-msvc\.node could not be replaced \(EPERM.*stop the plugin/s);

  const destination = backendDir(pluginDir, "win32-x64");
  assert.equal(fs.readFileSync(path.join(destination, "skia.win32-x64-msvc.node"), "utf8"), "binary");
  assert.doesNotThrow(() => assertNativePackage(destination, "@napi-rs/canvas-win32-x64-msvc", CANVAS_VERSION, "win32-x64"));
  assert.deepEqual(fs.readdirSync(destination).sort(), ["icudtl.dat", "package.json", "skia.win32-x64-msvc.node"]);

  // Once the plugin is stopped the next build replaces it.
  assert.deepEqual(bundle().map((item) => item.copy), ["updated"]);
  assert.equal(fs.readFileSync(path.join(destination, "skia.win32-x64-msvc.node"), "utf8"), "new binary");
});

test("a half-deleted package is repaired without touching its locked binary", (t) => {
  const { projectDir, pluginDir, cacheDir } = createFixture(t);
  writeNativePackage(installedDir(projectDir, "win32-x64"), "win32-x64", CANVAS_VERSION);
  const bundle = (options = {}) =>
    bundleNativeCanvas({ projectDir, pluginDir, cacheDir, targets: ["win32-x64"], fetchPackage: () => assert.fail("not fetched"), ...options });
  bundle();

  const destination = backendDir(pluginDir, "win32-x64");
  fs.rmSync(path.join(destination, "package.json"));
  fs.rmSync(path.join(destination, "icudtl.dat"));
  fs.writeFileSync(path.join(destination, `skia.win32-x64-msvc.node.${process.pid}.tmp`), "leftover");
  const lockedFs = createLockedFs(pluginDir);

  assert.deepEqual(bundle({ fsApi: lockedFs }).map((item) => item.copy), ["updated"]);
  assert.deepEqual(fs.readdirSync(destination).sort(), ["icudtl.dat", "package.json", "skia.win32-x64-msvc.node"]);
  assert.ok(lockedFs.writes.every((write) => !write.endsWith(".node")), lockedFs.writes.join("\n"));
});

test("a stale package with a locked binary is kept whole and reported instead of half-deleted", (t) => {
  const { projectDir, pluginDir, cacheDir } = createFixture(t);
  writeNativePackage(installedDir(projectDir, "darwin-arm64"), "darwin-arm64", CANVAS_VERSION);
  const stale = writeNativePackage(backendDir(pluginDir, "win32-x64"), "win32-x64", CANVAS_VERSION);
  const warnings = [];

  bundleNativeCanvas({
    projectDir,
    pluginDir,
    cacheDir,
    targets: ["darwin-arm64"],
    fsApi: createLockedFs(pluginDir),
    warn: (message) => warnings.push(message),
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not remove stale @napi-rs\/canvas-win32-x64-msvc \(EPERM/);
  assert.deepEqual(fs.readdirSync(stale).sort(), ["icudtl.dat", "package.json", "skia.win32-x64-msvc.node"]);

  bundleNativeCanvas({ projectDir, pluginDir, cacheDir, targets: ["darwin-arm64"] });
  assert.equal(fs.existsSync(stale), false);
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

test("native packages must contain every file their package.json lists", (t) => {
  const { projectDir, pluginDir, cacheDir } = createFixture(t);
  const installed = writeNativePackage(installedDir(projectDir, "win32-x64"), "win32-x64", CANVAS_VERSION);
  fs.rmSync(path.join(installed, "icudtl.dat"));
  const fetched = [];

  assert.throws(
    () => bundleNativeCanvas({
      projectDir,
      pluginDir,
      cacheDir,
      targets: ["win32-x64"],
      fetchPackage: ({ name }) => {
        fetched.push(name);
        const dir = writeNativePackage(path.join(cacheDir, "incomplete"), "win32-x64", CANVAS_VERSION);
        fs.rmSync(path.join(dir, "icudtl.dat"));
        return dir;
      },
    }),
    /canvas-win32-x64-msvc for win32-x64 is incomplete, missing icudtl\.dat/
  );
  assert.deepEqual(fetched, ["@napi-rs/canvas-win32-x64-msvc"], "an incomplete installed package is fetched again");
  assert.throws(
    () => assertNativePackage(
      writeNativePackage(path.join(cacheDir, "escape"), "win32-x64", CANVAS_VERSION, { files: ["../outside.dat"] }),
      "@napi-rs/canvas-win32-x64-msvc",
      CANVAS_VERSION,
      "win32-x64"
    ),
    /missing \.\.\/outside\.dat/
  );
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

test("the fetch cache lives in the project's node_modules/.cache, not a shared temp dir", () => {
  const projectDir = path.join(os.tmpdir(), "some-project");
  assert.equal(defaultCacheDir(projectDir), path.join(projectDir, "node_modules", ".cache", "flexbar-native-canvas"));
});

test("fetching verifies npm pack against package-lock.json, caches the tarball and reuses it", (t) => {
  const { projectDir } = createFixture(t);
  const name = "@napi-rs/canvas-darwin-x64";
  const tarball = darwinX64Tarball("binary");
  writeLockfile(projectDir, { [name]: { version: CANVAS_VERSION, integrity: sha512(tarball) } });
  const calls = [];
  const runNpm = fakeNpmPack(calls, () => tarball, projectDir);
  const fetch = () => {
    const logs = [];
    const result = fetchNativePackage({ name, version: CANVAS_VERSION, projectDir, runNpm, log: (line) => logs.push(line) });
    t.after(result.cleanup);
    return { ...result, logs };
  };

  const first = fetch();
  const second = fetch();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["pack", `${name}@${CANVAS_VERSION}`, "--pack-destination", calls[0][3], "--loglevel=error"]);
  assert.deepEqual([first.source, second.source], ["npm pack", "cache"]);
  assert.match(first.logs.join("\n"), /fetching @napi-rs\/canvas-darwin-x64@9\.8\.7 with npm pack/);
  assert.match(second.logs.join("\n"), /using cached @napi-rs\/canvas-darwin-x64@9\.8\.7/);
  assert.notEqual(first.dir, second.dir, "every build extracts into a fresh temp dir");
  assert.equal(fs.readFileSync(path.join(second.dir, "skia.darwin-x64.node"), "utf8"), "binary");
  assert.deepEqual(fs.readdirSync(defaultCacheDir(projectDir)), ["@napi-rs+canvas-darwin-x64-9.8.7.tgz"]);

  first.cleanup();
  assert.equal(fs.existsSync(first.dir), false, "cleanup removes the extracted package");
});

test("a tampered cache entry is ignored and fetched again", (t) => {
  const { projectDir } = createFixture(t);
  const name = "@napi-rs/canvas-darwin-x64";
  const genuine = darwinX64Tarball("binary");
  writeLockfile(projectDir, { [name]: { version: CANVAS_VERSION, integrity: sha512(genuine) } });
  const cached = path.join(defaultCacheDir(projectDir), "@napi-rs+canvas-darwin-x64-9.8.7.tgz");
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, darwinX64Tarball("planted"));
  const calls = [];
  const logs = [];

  const result = fetchNativePackage({
    name,
    version: CANVAS_VERSION,
    projectDir,
    runNpm: fakeNpmPack(calls, () => genuine, projectDir),
    log: (line) => logs.push(line),
  });
  t.after(result.cleanup);

  assert.equal(result.source, "npm pack");
  assert.equal(calls.length, 1);
  assert.match(logs.join("\n"), /ignoring cached .* does not match the package-lock\.json integrity/);
  assert.equal(fs.readFileSync(path.join(result.dir, "skia.darwin-x64.node"), "utf8"), "binary");
  assert.deepEqual(fs.readFileSync(cached), genuine, "the cache entry is replaced by the verified tarball");
});

test("npm pack output that does not match package-lock.json is rejected and not cached", (t) => {
  const { projectDir } = createFixture(t);
  const name = "@napi-rs/canvas-darwin-x64";
  writeLockfile(projectDir, { [name]: { version: CANVAS_VERSION, integrity: sha512(darwinX64Tarball("binary")) } });

  assert.throws(
    () => fetchNativePackage({
      name,
      version: CANVAS_VERSION,
      projectDir,
      runNpm: fakeNpmPack([], () => darwinX64Tarball("tampered"), projectDir),
    }),
    /does not match the integrity recorded in package-lock\.json/
  );
  assert.equal(fs.existsSync(defaultCacheDir(projectDir)), false);
});

test("without a lockfile entry nothing is cached and npm pack runs every time", (t) => {
  const { projectDir } = createFixture(t);
  const name = "@napi-rs/canvas-darwin-x64";
  writeLockfile(projectDir, { [name]: { version: "9.8.6", integrity: "sha512-AAAA" } });
  const calls = [];
  const runNpm = fakeNpmPack(calls, () => darwinX64Tarball("binary"), projectDir);

  for (let index = 0; index < 2; index += 1) {
    const result = fetchNativePackage({ name, version: CANVAS_VERSION, projectDir, runNpm });
    result.cleanup();
    assert.equal(result.source, "npm pack");
  }
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(defaultCacheDir(projectDir)), false);
  assert.equal(lockfileIntegrity(projectDir, name, CANVAS_VERSION), null);
  assert.equal(lockfileIntegrity(projectDir, name, "9.8.6"), "sha512-AAAA");
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
  const assets = RELEASE_ASSETS.map((asset) => ({ name: releaseAssetFileName(UUID, asset), targets: asset.targets }));

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

test("release packing runs plugin:pack once per target set and copies duplicate assets", (t) => {
  const { projectDir, outDir } = createReleaseFixture(t);
  fs.writeFileSync(path.join(projectDir, `${UUID}.flexplugin`), "stale pack from an earlier run");
  const calls = [];

  const files = packRelease({ projectDir, outDir, uuid: UUID, runNpm: fakePluginPack(projectDir, calls) });

  assert.deepEqual(calls, [
    { args: ["run", "plugin:pack"], cwd: projectDir, inherit: true, flexTarget: "darwin-arm64,darwin-x64" },
    { args: ["run", "plugin:pack"], cwd: projectDir, inherit: true, flexTarget: "win32-x64" },
    { args: ["run", "plugin:pack"], cwd: projectDir, inherit: true, flexTarget: "darwin-arm64,darwin-x64,win32-x64" },
  ]);
  assert.deepEqual(files.map((item) => [path.basename(item.file), item.targets.join(",")]), [
    [`${UUID}.darwin.arm64.flexplugin`, "darwin-arm64,darwin-x64"],
    [`${UUID}.darwin.x64.flexplugin`, "darwin-arm64,darwin-x64"],
    [`${UUID}.win32.x64.flexplugin`, "win32-x64"],
    [`${UUID}.flexplugin`, "darwin-arm64,darwin-x64,win32-x64"],
  ]);
  assert.deepEqual(fs.readdirSync(outDir).sort(), files.map((item) => path.basename(item.file)).sort());
  assert.deepEqual(
    fs.readFileSync(path.join(outDir, `${UUID}.darwin.x64.flexplugin`)),
    fs.readFileSync(path.join(outDir, `${UUID}.darwin.arm64.flexplugin`))
  );
  assert.equal(fs.existsSync(path.join(projectDir, `${UUID}.flexplugin`)), false, "the packed file is moved into outDir");
  for (const item of files) assert.equal(item.bytes, fs.statSync(item.file).size);

  const win32Entries = readZipEntries(path.join(outDir, `${UUID}.win32.x64.flexplugin`)).map((entry) => entry.name);
  assert.ok(win32Entries.includes("backend/node_modules/@napi-rs/canvas-win32-x64-msvc/icudtl.dat"));
  assert.deepEqual(verifyReleaseDir({ projectDir, outDir, uuid: UUID }).map((item) => path.basename(item.file)), files.map((item) => path.basename(item.file)));
});

test("release packing fails loudly when an asset ships config.json", (t) => {
  const { projectDir, outDir } = createReleaseFixture(t);
  assert.throws(
    () => packRelease({ projectDir, outDir, uuid: UUID, runNpm: fakePluginPack(projectDir, [], { extraFiles: { "config.json": "{}" } }) }),
    (error) => {
      assert.match(error.message, new RegExp(`${UUID}\\.darwin\\.arm64\\.flexplugin contains config\\.json; the plugin config must not be shipped`));
      assert.match(error.message, new RegExp(`${UUID}\\.flexplugin contains config\\.json`));
      return true;
    }
  );
});

test("release packing fails when an asset bundles other native packages than its targets", (t) => {
  const { projectDir, outDir } = createReleaseFixture(t);
  // e.g. the doctor/build ignored FLEX_TARGET and packed the build host's binary only
  const runNpm = fakePluginPack(projectDir, [], { targetsFor: () => ["darwin-arm64"] });

  assert.throws(
    () => packRelease({ projectDir, outDir, uuid: UUID, runNpm }),
    /darwin\.x64\.flexplugin bundles @napi-rs\/canvas-darwin-arm64, expected exactly @napi-rs\/canvas-darwin-arm64, @napi-rs\/canvas-darwin-x64[\s\S]*win32\.x64\.flexplugin bundles @napi-rs\/canvas-darwin-arm64, expected exactly @napi-rs\/canvas-win32-x64-msvc/
  );
});

test("release asset check requires every file a native package lists, e.g. icudtl.dat", (t) => {
  const { projectDir } = createReleaseFixture(t);
  const file = path.join(projectDir, "win32.flexplugin");
  fs.writeFileSync(file, createZip(pluginZipFiles(["win32-x64"], { omit: ["backend/node_modules/@napi-rs/canvas-win32-x64-msvc/icudtl.dat"] })));

  assert.deepEqual(inspectReleaseAsset(file, ["win32-x64"]), ["is missing @napi-rs/canvas-win32-x64-msvc/icudtl.dat"]);
  assert.deepEqual(inspectReleaseAsset(file, ["darwin-arm64"]), [
    "bundles @napi-rs/canvas-win32-x64-msvc, expected exactly @napi-rs/canvas-darwin-arm64",
  ]);
});

test("release packing fails when plugin:pack produced no .flexplugin", (t) => {
  const { projectDir, outDir } = createReleaseFixture(t);
  fs.writeFileSync(path.join(projectDir, `${UUID}.flexplugin`), "stale pack from an earlier run");

  assert.throws(
    () => packRelease({ projectDir, outDir, uuid: UUID, runNpm: () => {} }),
    /plugin:pack \(FLEX_TARGET=darwin-arm64,darwin-x64\) did not produce/
  );
  assert.equal(fs.existsSync(path.join(outDir, `${UUID}.darwin.arm64.flexplugin`)), false);
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

/** Mirrors the published packages: the Windows one also ships icudtl.dat. */
function nativePackageJson(target, version, overrides = {}) {
  const [platform, arch] = target.split("-");
  const suffix = NATIVE_CANVAS_TARGETS[target];
  const main = `skia.${suffix}.node`;
  const files = platform === "win32" ? [main, "icudtl.dat"] : [main];
  return { name: nativeCanvasPackageName(target), version, os: [platform], cpu: [arch], main, files, ...overrides };
}

function writeNativePackage(dir, target, version, { binary = true, ...overrides } = {}) {
  const packageJson = nativePackageJson(target, version, overrides);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson));
  if (binary) fs.writeFileSync(path.join(dir, packageJson.main), "binary");
  if (packageJson.files.includes("icudtl.dat")) fs.writeFileSync(path.join(dir, "icudtl.dat"), "icu data");
  return dir;
}

/**
 * fs whose writes into the plugin backend are recorded, and that refuses to
 * replace or delete a .node file there with EPERM, like Windows does while
 * FlexDesigner has the binary loaded.
 */
function createLockedFs(pluginDir) {
  const backend = path.join(pluginDir, "backend");
  const writes = [];
  const inBackend = (file) => path.resolve(String(file)).startsWith(backend + path.sep);
  const eperm = (file) => Object.assign(new Error(`EPERM: operation not permitted, '${file}'`), { code: "EPERM" });
  const lockedTree = (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory() &&
    fs.readdirSync(dir).some((entry) => entry.endsWith(".node") || lockedTree(path.join(dir, entry)));
  const record = (file) => { if (inBackend(file)) writes.push(path.relative(backend, String(file))); };
  return {
    ...fs,
    writes,
    copyFileSync(source, destination, ...rest) {
      record(destination);
      return fs.copyFileSync(source, destination, ...rest);
    },
    renameSync(source, destination) {
      record(destination);
      if (inBackend(destination) && String(destination).endsWith(".node") && fs.existsSync(destination)) throw eperm(destination);
      return fs.renameSync(source, destination);
    },
    unlinkSync(file) {
      record(file);
      if (inBackend(file) && String(file).endsWith(".node")) throw eperm(file);
      return fs.unlinkSync(file);
    },
    rmSync(file, options) {
      if (inBackend(file) && fs.existsSync(file)) record(file);
      if (inBackend(file) && (String(file).endsWith(".node") || lockedTree(file))) throw eperm(file);
      return fs.rmSync(file, options);
    },
  };
}

function writeLockfile(projectDir, packages) {
  const entries = Object.fromEntries(Object.entries(packages).map(([name, entry]) => [`node_modules/${name}`, entry]));
  fs.writeFileSync(path.join(projectDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...entries } }));
}

function sha512(buffer) {
  return `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
}

function darwinX64Tarball(binary) {
  return createTarball({
    "package/package.json": JSON.stringify(nativePackageJson("darwin-x64", CANVAS_VERSION)),
    "package/skia.darwin-x64.node": binary,
  });
}

function fakeNpmPack(calls, tarball, projectDir) {
  return (args, options) => {
    calls.push(args);
    assert.equal(options.cwd, projectDir);
    const destination = args[args.indexOf("--pack-destination") + 1];
    fs.writeFileSync(path.join(destination, "napi-rs-canvas-darwin-x64-9.8.7.tgz"), tarball());
  };
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

function createReleaseFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  return { projectDir, outDir: path.join(root, "dist") };
}

/** Stands in for `npm run plugin:pack`: zips a plugin bundling the FLEX_TARGET binaries to <uuid>.flexplugin. */
function fakePluginPack(projectDir, calls, { targetsFor = resolveCanvasTargets, extraFiles = {} } = {}) {
  return (args, options) => {
    calls.push({ args, cwd: options.cwd, inherit: options.inherit, flexTarget: options.env.FLEX_TARGET });
    const files = { ...pluginZipFiles(targetsFor(options.env.FLEX_TARGET)), ...extraFiles };
    fs.writeFileSync(path.join(projectDir, `${UUID}.flexplugin`), createZip(files));
  };
}

function pluginZipFiles(targets, { omit = [] } = {}) {
  const files = {
    "manifest.json": JSON.stringify({ uuid: UUID }),
    "backend/": "",
    "backend/plugin.cjs": "module.exports = {};",
    "backend/node_modules/@napi-rs/canvas/package.json": JSON.stringify({ name: "@napi-rs/canvas", version: CANVAS_VERSION }),
    "backend/node_modules/@napi-rs/canvas/index.js": "module.exports = {};",
  };
  for (const target of targets) {
    const packageJson = nativePackageJson(target, CANVAS_VERSION);
    const base = `backend/node_modules/${packageJson.name}/`;
    files[`${base}package.json`] = JSON.stringify(packageJson);
    for (const file of packageJson.files) files[`${base}${file}`] = `${file} contents `.repeat(8);
  }
  for (const name of omit) delete files[name];
  return files;
}

/** Minimal zip writer: stored entries for small files, deflated ones otherwise (both kinds flexcli's archiver emits). */
function createZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const method = data.length > 32 ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const fileName = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, fileName);
    offset += header.length + fileName.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
