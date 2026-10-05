"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { missingPackageFiles } = require("../scripts/native-canvas.cjs");
const { RELEASE_ASSETS, releaseAssetFileName } = require("../scripts/pack-release.cjs");

test("Rollup patches FlexDesigner reconnect retry to preserve transport context", () => {
  const rollupConfig = fs.readFileSync(path.join(__dirname, "..", "rollup.config.mjs"), "utf8");

  assert.match(rollupConfig, /patchFlexdesignerTransportRetry/);
  assert.match(rollupConfig, /setTimeout\(\(\) => this\.start\(\), 5000\)/);
});

test("bundled plugin does not contain the unbound FlexDesigner reconnect retry", () => {
  const bundle = fs.readFileSync(
    path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin", "backend", "plugin.cjs"),
    "utf8"
  );

  assert.doesNotMatch(bundle, /setTimeout\(this\.start, 5000\)/);
});

test("Rollup bundles the native canvas binaries selected by FLEX_TARGET", () => {
  const rollupConfig = fs.readFileSync(path.join(__dirname, "..", "rollup.config.mjs"), "utf8");

  assert.match(rollupConfig, /resolveCanvasTargets\(process\.env\.FLEX_TARGET\)/);
  assert.match(rollupConfig, /bundleNativeCanvas\(/);
  assert.match(rollupConfig, /this\.error\(/);
});

test("bundled plugin ships native canvas binaries matching @napi-rs/canvas", () => {
  const scopeDir = path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin", "backend", "node_modules", "@napi-rs");
  const canvas = JSON.parse(fs.readFileSync(path.join(scopeDir, "canvas", "package.json"), "utf8"));
  const nativePackages = fs.readdirSync(scopeDir).filter((entry) => entry.startsWith("canvas-"));

  assert.ok(nativePackages.length > 0, "at least one @napi-rs/canvas-* package is bundled");
  for (const entry of nativePackages) {
    const nativePackage = JSON.parse(fs.readFileSync(path.join(scopeDir, entry, "package.json"), "utf8"));
    assert.equal(nativePackage.version, canvas.version, entry);
    assert.ok(fs.statSync(path.join(scopeDir, entry, nativePackage.main)).size > 0, `${entry} binary`);
    assert.deepEqual(missingPackageFiles(path.join(scopeDir, entry), nativePackage), [], `${entry} files`);
  }
});

test("release workflow uploads the generic asset first, then the platform assets packed by release:pack", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin", "manifest.json"), "utf8")
  );

  assert.equal(packageJson.scripts["release:pack"], "node scripts/pack-release.cjs");
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /run: npm install -g @eniac\/flexcli@1\.0\.7\n/);
  assert.match(workflow, /run: npm run release:pack/);
  assert.match(workflow, /node scripts\/pack-release\.cjs --verify dist/);
  assert.doesNotMatch(workflow, /dist\/\*\.flexplugin\s*$/m, "assets are uploaded by name, in a fixed order");

  // FlexDesigner versions without <os>.<arch> lookup take the first .flexplugin of the release.
  const steps = workflow.split(/\n(?=\s*- name: )/);
  const uploads = steps.filter((step) => /uses: softprops\/action-gh-release@v2/.test(step));
  const uploaded = (step) => [...step.matchAll(/dist\/(\S+\.flexplugin)/g)].map((match) => match[1]);
  const names = RELEASE_ASSETS.map((asset) => releaseAssetFileName(manifest.uuid, asset));
  const generic = `${manifest.uuid}.flexplugin`;

  assert.equal(uploads.length, 2);
  assert.deepEqual(uploaded(uploads[0]), [generic]);
  assert.deepEqual(uploaded(uploads[1]).sort(), names.filter((name) => name !== generic).sort());
  for (const step of uploads) assert.match(step, /fail_on_unmatched_files: true/);
  assert.ok(workflow.indexOf("--verify dist") < workflow.indexOf(uploads[0].trim()), "assets are checked before upload");
});

test("token usage config page exposes recent chart display mode", () => {
  const page = fs.readFileSync(
    path.join(__dirname, "..", "com.aspen.flexbar-ai-dashboard.plugin", "ui", "token-usage.vue"),
    "utf8"
  );

  assert.match(page, /Display mode/);
  assert.match(page, /tokenDisplayMode/);
  assert.match(page, /recentChart/);
});
