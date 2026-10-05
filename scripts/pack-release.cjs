"use strict";

// Packs the .flexplugin files attached to a GitHub release.
//
// When FlexDesigner installs a plugin from a GitHub repository link it looks for
// "<name>.<os>.<arch>.flexplugin" release assets (os: win32 / darwin / linux,
// arch: x64 / arm64) and only falls back to the first other .flexplugin asset
// when none matches. Its Plugin Manager (FlexDesigner 2.2.x) tries the
// arch-agnostic `\.<os alias>\.(x64|arm64)?\.flexplugin$` patterns before the
// exact-arch one, so on a Mac either darwin asset may be picked whatever the CPU
// is; each darwin asset therefore carries both macOS binaries. The OS name must
// be followed by an arch: "<name>.darwin.flexplugin" matches none of its patterns.
//
// usage: node scripts/pack-release.cjs [outDir]   (default: dist)
// Needs `flexcli` on PATH for `npm run plugin:pack`.

const fs = require("node:fs");
const path = require("node:path");
const { DESKTOP_TARGETS, TARGET_ALIASES, runNpmCommand } = require("./native-canvas.cjs");

const projectDir = path.resolve(__dirname, "..");
const pluginDirName = "com.aspen.flexbar-ai-dashboard.plugin";

/** Release asset name suffix (between the plugin uuid and ".flexplugin") -> bundled canvas targets. */
const RELEASE_ASSETS = Object.freeze([
  Object.freeze({ suffix: ".darwin.arm64", targets: TARGET_ALIASES.darwin }),
  Object.freeze({ suffix: ".darwin.x64", targets: TARGET_ALIASES.darwin }),
  Object.freeze({ suffix: ".win32.x64", targets: TARGET_ALIASES.win32 }),
  // Generic fallback for manual installs and FlexDesigner versions without OS-specific lookup.
  Object.freeze({ suffix: "", targets: DESKTOP_TARGETS }),
]);

function releaseAssetFileName(uuid, asset) {
  return `${uuid}${asset.suffix}.flexplugin`;
}

function readPluginUuid() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, pluginDirName, "manifest.json"), "utf8"));
  return manifest.uuid;
}

function packRelease({ outDir = path.join(projectDir, "dist"), uuid = readPluginUuid(), runNpm = runNpmCommand } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const packedByTarget = new Map();
  const files = [];

  for (const asset of RELEASE_ASSETS) {
    const flexTarget = asset.targets.join(",");
    const destination = path.join(outDir, releaseAssetFileName(uuid, asset));

    if (packedByTarget.has(flexTarget)) {
      fs.copyFileSync(packedByTarget.get(flexTarget), destination);
    } else {
      const env = { ...process.env, FLEX_TARGET: flexTarget };
      runNpm(["run", "build"], { cwd: projectDir, env, inherit: true });
      runNpm(["run", "plugin:pack"], { cwd: projectDir, env, inherit: true });
      // flexcli writes <uuid>.flexplugin next to the plugin directory.
      moveFile(path.join(projectDir, `${uuid}.flexplugin`), destination);
      packedByTarget.set(flexTarget, destination);
    }

    files.push({ file: destination, targets: asset.targets, bytes: fs.statSync(destination).size });
  }
  return files;
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (!error || error.code !== "EXDEV") throw error;
    fs.copyFileSync(source, destination);
    fs.rmSync(source);
  }
}

if (require.main === module) {
  const outDir = path.resolve(process.argv[2] || path.join(projectDir, "dist"));
  for (const { file, targets, bytes } of packRelease({ outDir })) {
    console.log(`${file}  ${(bytes / 1024 / 1024).toFixed(1)} MB  [${targets.join(", ")}]`);
  }
}

module.exports = {
  RELEASE_ASSETS,
  packRelease,
  releaseAssetFileName,
};
