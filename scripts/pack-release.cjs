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
// Every asset is checked after packing: it must bundle exactly the native
// canvas packages of its targets, with every file their package.json lists
// (icudtl.dat for Windows), and must not contain the developer's config.json.
//
// usage: node scripts/pack-release.cjs [outDir]            pack and check (default outDir: dist)
//        node scripts/pack-release.cjs --verify [outDir]   only check already packed assets
// `npm run plugin:pack` builds, runs the doctor, and packs via scripts/flexcli.cjs.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  CANVAS_PACKAGE,
  DESKTOP_TARGETS,
  TARGET_ALIASES,
  nativeCanvasPackageName,
  runNpmCommand,
} = require("./native-canvas.cjs");

const PROJECT_DIR = path.resolve(__dirname, "..");
const PLUGIN_DIR_NAME = "com.aspen.flexbar-ai-dashboard.plugin";

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

function readPluginUuid(projectDir = PROJECT_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, PLUGIN_DIR_NAME, "manifest.json"), "utf8"));
  return manifest.uuid;
}

function packRelease({
  projectDir = PROJECT_DIR,
  outDir = path.join(projectDir, "dist"),
  uuid = readPluginUuid(projectDir),
  runNpm = runNpmCommand,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  // flexcli writes <uuid>.flexplugin next to the plugin directory.
  const packed = path.join(projectDir, `${uuid}.flexplugin`);
  const packedByTarget = new Map();
  const files = [];

  for (const asset of RELEASE_ASSETS) {
    const flexTarget = asset.targets.join(",");
    const destination = path.join(outDir, releaseAssetFileName(uuid, asset));

    if (packedByTarget.has(flexTarget)) {
      fs.copyFileSync(packedByTarget.get(flexTarget), destination);
    } else {
      // A leftover from an earlier `npm run plugin:pack` must never be renamed into a release asset.
      fs.rmSync(packed, { force: true });
      const env = { ...process.env, FLEX_TARGET: flexTarget };
      // plugin:pack runs build + doctor for FLEX_TARGET before packing.
      runNpm(["run", "plugin:pack"], { cwd: projectDir, env, inherit: true });
      if (!fs.existsSync(packed)) {
        throw new Error(`npm run plugin:pack (FLEX_TARGET=${flexTarget}) did not produce ${packed}`);
      }
      moveFile(packed, destination);
      packedByTarget.set(flexTarget, destination);
    }

    files.push({ file: destination, targets: asset.targets, bytes: fs.statSync(destination).size });
  }

  assertReleaseAssets(files);
  return files;
}

/** Checks the release assets already in outDir (the CI step after packing). */
function verifyReleaseDir({ projectDir = PROJECT_DIR, outDir = path.join(projectDir, "dist"), uuid = readPluginUuid(projectDir) } = {}) {
  const files = RELEASE_ASSETS.map((asset) => {
    const file = path.join(outDir, releaseAssetFileName(uuid, asset));
    return { file, targets: asset.targets, bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 };
  });
  assertReleaseAssets(files);
  return files;
}

function assertReleaseAssets(files) {
  const problems = [];
  for (const { file, targets } of files) {
    const assetProblems = fs.existsSync(file) ? inspectReleaseAsset(file, targets) : ["is missing"];
    problems.push(...assetProblems.map((problem) => `${path.basename(file)} ${problem}`));
  }
  if (problems.length > 0) {
    throw new Error(`Release assets failed the bundle check:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Problems with one .flexplugin (a zip of the plugin directory) bundling the given canvas targets. */
function inspectReleaseAsset(file, targets) {
  const entries = readZipEntries(file);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const problems = [];

  // The plugin's config.json holds the developer's settings and local paths.
  const configs = entries.filter((entry) => /(^|\/)config\.json$/.test(entry.name) && !/(^|\/)node_modules\//.test(entry.name));
  if (configs.length > 0) {
    problems.push(`contains ${configs.map((entry) => entry.name).join(", ")}; the plugin config must not be shipped`);
  }
  if (!byName.has("manifest.json")) problems.push("has no manifest.json at its root");

  const scope = "backend/node_modules/@napi-rs/";
  const bundled = [...new Set(
    entries
      .filter((entry) => entry.name.startsWith(`${scope}canvas-`))
      .map((entry) => `@napi-rs/${entry.name.slice(scope.length).split("/")[0]}`)
  )].sort();
  const expected = targets.map(nativeCanvasPackageName).sort();
  if (bundled.join(",") !== expected.join(",")) {
    problems.push(`bundles ${bundled.join(", ") || "no native canvas package"}, expected exactly ${expected.join(", ")}`);
  }

  const canvas = readZipJson(file, byName.get(`${scope}canvas/package.json`));
  if (!canvas) problems.push(`does not bundle ${CANVAS_PACKAGE}`);
  for (const name of expected) {
    const base = `backend/node_modules/${name}/`;
    const nativePackage = readZipJson(file, byName.get(`${base}package.json`));
    if (!nativePackage) {
      if (bundled.includes(name)) problems.push(`has no ${name}/package.json`);
      continue;
    }
    if (canvas && nativePackage.version !== canvas.version) {
      problems.push(`bundles ${name}@${nativePackage.version} with ${CANVAS_PACKAGE}@${canvas.version}`);
    }
    const listed = Array.isArray(nativePackage.files) ? nativePackage.files : [];
    for (const item of new Set([nativePackage.main, ...listed])) {
      if (typeof item !== "string" || /[*?[\]{}!]/.test(item)) continue;
      const entryName = `${base}${path.posix.normalize(item).replace(/^\.\//, "").replace(/\/$/, "")}`;
      const entry = byName.get(entryName);
      const isDirectory = !entry && entries.some((other) => other.name.startsWith(`${entryName}/`));
      if (!entry && !isDirectory) problems.push(`is missing ${name}/${item}`);
      else if (entry && item === nativePackage.main && entry.size === 0) problems.push(`has an empty ${name}/${item}`);
    }
  }
  return problems;
}

function readZipJson(file, entry) {
  if (!entry) return null;
  try {
    return JSON.parse(readZipEntry(file, entry).toString("utf8"));
  } catch {
    return null;
  }
}

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;

/** Lists a zip's entries from its central directory: [{ name, method, compressedSize, size, localHeaderOffset }]. */
function readZipEntries(file) {
  const fd = fs.openSync(file, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const tailSize = Math.min(fileSize, 22 + 0xffff);
    const tail = readAt(fd, fileSize - tailSize, tailSize);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
        end = offset;
        break;
      }
    }
    if (end < 0) throw new Error(`${file} is not a zip archive`);
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error(`${file} is a ZIP64 archive, which this check does not read`);
    }

    const directory = readAt(fd, directoryOffset, directorySize);
    const entries = [];
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER) {
        throw new Error(`${file} has a corrupt zip central directory`);
      }
      const nameLength = directory.readUInt16LE(offset + 28);
      entries.push({
        name: directory.toString("utf8", offset + 46, offset + 46 + nameLength).replace(/\\/g, "/"),
        method: directory.readUInt16LE(offset + 10),
        compressedSize: directory.readUInt32LE(offset + 20),
        size: directory.readUInt32LE(offset + 24),
        localHeaderOffset: directory.readUInt32LE(offset + 42),
      });
      offset += 46 + nameLength + directory.readUInt16LE(offset + 30) + directory.readUInt16LE(offset + 32);
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Returns the uncompressed contents of a stored or deflated zip entry. */
function readZipEntry(file, entry) {
  const fd = fs.openSync(file, "r");
  try {
    const header = readAt(fd, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER) throw new Error(`${file}: bad local header for ${entry.name}`);
    const dataOffset = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = readAt(fd, dataOffset, entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`${file}: unsupported compression method ${entry.method} for ${entry.name}`);
  } finally {
    fs.closeSync(fd);
  }
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const bytes = fs.readSync(fd, buffer, done, length - done, position + done);
    if (bytes === 0) throw new Error("unexpected end of zip file");
    done += bytes;
  }
  return buffer;
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

function main(argv = process.argv.slice(2)) {
  const verifyOnly = argv.includes("--verify");
  const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--verify");
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  if (unknown.length > 0 || positional.length > 1) {
    console.error("usage: node scripts/pack-release.cjs [--verify] [outDir]");
    return 2;
  }
  const outDir = path.resolve(positional[0] || path.join(PROJECT_DIR, "dist"));
  try {
    const files = verifyOnly ? verifyReleaseDir({ outDir }) : packRelease({ outDir });
    for (const { file, targets, bytes } of files) {
      const natives = targets.map(nativeCanvasPackageName).join(", ");
      console.log(`${file}  ${(bytes / 1024 / 1024).toFixed(1)} MB  [${natives}]`);
    }
    console.log(`OK: ${files.length} release assets bundle exactly their native canvas packages and no config.json.`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  RELEASE_ASSETS,
  inspectReleaseAsset,
  packRelease,
  readZipEntries,
  readZipEntry,
  releaseAssetFileName,
  verifyReleaseDir,
};
