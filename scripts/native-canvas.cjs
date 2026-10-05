"use strict";

// Selects, fetches and bundles the @napi-rs/canvas native binaries that ship
// inside com.aspen.flexbar-ai-dashboard.plugin/backend/node_modules.
//
// npm only installs the native package for the machine running `npm install`,
// so a plugin built on one OS cannot render PNG keys on another unless the
// other platform's binary is fetched explicitly. FLEX_TARGET picks the
// platforms to bundle (default: the build host).

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const CANVAS_PACKAGE = "@napi-rs/canvas";
const CACHE_DIR_NAME = "flexbar-native-canvas";
/** Errors for a file another process keeps open (Windows: a loaded .node binary) or that is not writable. */
const LOCKED_FILE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Build target (`<process.platform>-<process.arch>`) -> @napi-rs/canvas native package suffix. */
const NATIVE_CANVAS_TARGETS = Object.freeze({
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "linux-arm": "linux-arm-gnueabihf",
  "android-arm64": "android-arm64",
});

/** Platforms FlexDesigner runs on, matching the "mac" and "windows" entries of manifest.json. */
const DESKTOP_TARGETS = Object.freeze(["darwin-arm64", "darwin-x64", "win32-x64"]);

const TARGET_ALIASES = Object.freeze({
  all: DESKTOP_TARGETS,
  darwin: Object.freeze(["darwin-arm64", "darwin-x64"]),
  win32: Object.freeze(["win32-x64"]),
});

function hostCanvasTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  return Object.prototype.hasOwnProperty.call(NATIVE_CANVAS_TARGETS, target) ? target : null;
}

function nativeCanvasPackageName(target) {
  const suffix = NATIVE_CANVAS_TARGETS[target];
  if (!suffix) throw new Error(`Unknown native canvas target "${target}"`);
  return `${CANVAS_PACKAGE}-${suffix}`;
}

/**
 * Turns a FLEX_TARGET value into a list of build targets.
 * Accepts comma/space separated targets ("darwin-arm64,win32-x64"), package
 * suffixes ("win32-x64-msvc"), the aliases "all" / "darwin" / "win32", and
 * "host". An empty value means the build host only.
 */
function resolveCanvasTargets(spec, { platform = process.platform, arch = process.arch } = {}) {
  const host = hostCanvasTarget(platform, arch);
  const tokens = String(spec ?? "").split(/[\s,]+/).map((token) => token.trim().toLowerCase()).filter(Boolean);

  if (tokens.length === 0) {
    if (!host) {
      throw new Error(
        `No @napi-rs/canvas binary is known for build host ${platform}-${arch}. ` +
        `Set FLEX_TARGET to one of: ${describeAcceptedTargets()}`
      );
    }
    return [host];
  }

  const targets = [];
  for (const token of tokens) {
    for (const target of expandTargetToken(token, host, platform, arch)) {
      if (!targets.includes(target)) targets.push(target);
    }
  }
  return targets;
}

function expandTargetToken(token, host, platform, arch) {
  if (token === "host") {
    if (!host) throw new Error(`FLEX_TARGET "host": no @napi-rs/canvas binary is known for ${platform}-${arch}`);
    return [host];
  }
  if (Object.prototype.hasOwnProperty.call(TARGET_ALIASES, token)) return TARGET_ALIASES[token];

  const name = token.startsWith(`${CANVAS_PACKAGE}-`) ? token.slice(CANVAS_PACKAGE.length + 1) : token;
  if (Object.prototype.hasOwnProperty.call(NATIVE_CANVAS_TARGETS, name)) return [name];
  const bySuffix = Object.keys(NATIVE_CANVAS_TARGETS).find((target) => NATIVE_CANVAS_TARGETS[target] === name);
  if (bySuffix) return [bySuffix];

  throw new Error(`Unknown FLEX_TARGET entry "${token}". Use one of: ${describeAcceptedTargets()}`);
}

function describeAcceptedTargets() {
  return [...Object.keys(TARGET_ALIASES), "host", ...Object.keys(NATIVE_CANVAS_TARGETS)].join(", ");
}

/**
 * Copies @napi-rs/canvas plus the native package of every requested target
 * into <pluginDir>/backend/node_modules, removes native packages of targets
 * that were not requested, and throws if any requested binary is missing.
 * Native packages always match the installed @napi-rs/canvas version: the copy
 * in node_modules is used when it matches, otherwise the exact version is
 * fetched with `npm pack` (no package.json, lockfile or node_modules changes).
 * Packages already bundled with identical contents are left untouched.
 */
function bundleNativeCanvas({
  projectDir,
  pluginDir,
  targets,
  cacheDir = defaultCacheDir(projectDir),
  fetchPackage = fetchNativePackage,
  fsApi = fs,
  log = () => {},
  warn = log,
}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("No native canvas targets were requested");
  }

  const canvasDir = packageDir(path.join(projectDir, "node_modules"), CANVAS_PACKAGE);
  const canvasPackage = readPackageJson(canvasDir);
  if (!canvasPackage) {
    throw new Error(`${CANVAS_PACKAGE} is not installed in ${path.join(projectDir, "node_modules")}; run npm install`);
  }
  const version = canvasPackage.version;
  const publishedNativePackages = canvasPackage.optionalDependencies || {};
  const cleanups = [];

  try {
    const sources = targets.map((target) => {
      const name = nativeCanvasPackageName(target);
      if (!Object.prototype.hasOwnProperty.call(publishedNativePackages, name)) {
        throw new Error(`${CANVAS_PACKAGE}@${version} does not publish ${name} (target ${target})`);
      }
      const installedDir = packageDir(path.join(projectDir, "node_modules"), name);
      if (isUsableNativePackage(installedDir, name, version)) {
        return { target, name, dir: installedDir, source: "node_modules" };
      }
      const fetched = fetchPackage({ name, version, target, cacheDir, projectDir, log });
      const { dir, source = "npm pack", cleanup } = typeof fetched === "string" ? { dir: fetched } : fetched;
      if (cleanup) cleanups.push(cleanup);
      assertNativePackage(dir, name, version, target);
      return { target, name, dir, source };
    });

    // Native packages first: if Windows keeps one locked, the build stops before
    // the JS package moves to a version its binary does not match.
    const backendModules = path.join(pluginDir, "backend", "node_modules");
    const bundled = sources.map(({ dir, ...source }) => {
      const destination = packageDir(backendModules, source.name);
      const copy = syncPackage(dir, destination, { fsApi });
      const binary = assertNativePackage(destination, source.name, version, source.target);
      return { ...source, version, copy, binary, bytes: fs.statSync(binary).size };
    });
    const canvasCopy = syncPackage(canvasDir, packageDir(backendModules, CANVAS_PACKAGE), { fsApi });
    log(`${CANVAS_PACKAGE}@${version}: ${describeCopy(canvasCopy)}`);
    removeUnrequestedNativePackages(backendModules, new Set(sources.map((source) => source.name)), { fsApi, log, warn });
    return bundled;
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

/** Human-readable syncPackage() result for build logs. */
function describeCopy(copy) {
  return copy === "unchanged" ? "unchanged, copy skipped" : copy;
}

/** Project-local and gitignored (like other build caches), never a shared temp dir. */
function defaultCacheDir(projectDir = process.cwd()) {
  return path.join(projectDir, "node_modules", ".cache", CACHE_DIR_NAME);
}

function packageDir(nodeModulesDir, packageName) {
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

function nativeBinaryPath(dir, packageJson) {
  const main = packageJson && typeof packageJson.main === "string" ? packageJson.main : "";
  return main.endsWith(".node") ? path.join(dir, main) : null;
}

/**
 * Entries of package.json "files" that are missing from dir (e.g. icudtl.dat,
 * which the Windows binary needs next to it). Glob patterns are not expanded.
 */
function missingPackageFiles(dir, packageJson) {
  const root = path.resolve(dir);
  const files = Array.isArray(packageJson && packageJson.files) ? packageJson.files : [];
  return files.filter((entry) => {
    if (typeof entry !== "string" || /[*?[\]{}!]/.test(entry)) return false;
    const file = path.resolve(root, entry);
    return !(file === root || file.startsWith(root + path.sep)) || !fs.existsSync(file);
  });
}

function isUsableNativePackage(dir, name, version) {
  const packageJson = readPackageJson(dir);
  if (!packageJson || packageJson.name !== name || packageJson.version !== version) return false;
  const binary = nativeBinaryPath(dir, packageJson);
  return !!binary && fs.existsSync(binary) && fs.statSync(binary).size > 0 && missingPackageFiles(dir, packageJson).length === 0;
}

function assertNativePackage(dir, name, version, target) {
  const packageJson = readPackageJson(dir);
  if (!packageJson) throw new Error(`Native canvas package for ${target} is missing: ${dir}`);
  if (packageJson.name !== name || packageJson.version !== version) {
    throw new Error(
      `Native canvas package for ${target} is ${packageJson.name}@${packageJson.version}, expected ${name}@${version}`
    );
  }
  const [platform, arch] = target.split("-");
  if (Array.isArray(packageJson.os) && !packageJson.os.includes(platform)) {
    throw new Error(`${name} targets os ${packageJson.os.join("/")}, expected ${platform}`);
  }
  if (Array.isArray(packageJson.cpu) && !packageJson.cpu.includes(arch)) {
    throw new Error(`${name} targets cpu ${packageJson.cpu.join("/")}, expected ${arch}`);
  }
  const binary = nativeBinaryPath(dir, packageJson);
  if (!binary || !fs.existsSync(binary) || fs.statSync(binary).size === 0) {
    throw new Error(`Native canvas binary for ${target} is missing from ${dir}`);
  }
  const missing = missingPackageFiles(dir, packageJson);
  if (missing.length > 0) {
    throw new Error(`${name} for ${target} is incomplete, missing ${missing.join(", ")} in ${dir}`);
  }
  return binary;
}

/**
 * Makes destination an exact copy of the package in source and returns
 * "unchanged", "copied" (destination was missing) or "updated".
 *
 * Files whose size and SHA-256 already match are not touched, so a rebuild
 * with unchanged binaries writes nothing (Windows keeps a loaded .node file
 * locked while FlexDesigner runs the plugin, and the binaries are 10-30 MB).
 * Nothing is deleted up front: changed files are written next to their target
 * and renamed over it, native binaries first and package.json last, so a
 * locked binary stops the update before the rest of the package changes.
 */
function syncPackage(source, destination, { fsApi = fs } = {}) {
  const sourceFiles = listPackageFiles(source);
  const existed = fs.existsSync(destination);
  const destinationFiles = existed ? listPackageFiles(destination) : [];
  const changed = sourceFiles.filter((file) => !sameFileContents(path.join(source, file), path.join(destination, file)));
  const extra = destinationFiles.filter((file) => !sourceFiles.includes(file));
  if (existed && changed.length === 0 && extra.length === 0) return "unchanged";

  changed.sort((a, b) => updateRank(a) - updateRank(b) || a.localeCompare(b));
  for (const file of changed) {
    replaceFile(path.join(source, file), path.join(destination, file), fsApi);
  }
  for (const file of extra) {
    try {
      fsApi.unlinkSync(path.join(destination, file));
    } catch (error) {
      throw lockedFileError(error, path.join(destination, file));
    }
  }
  return existed ? "updated" : "copied";
}

function updateRank(file) {
  if (file.endsWith(".node")) return 0;
  return file === "package.json" ? 2 : 1;
}

/** Relative paths of every file below dir, following symlinks. */
function listPackageFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix)).sort()) {
    const relative = path.join(prefix, entry);
    if (fs.statSync(path.join(dir, relative)).isDirectory()) files.push(...listPackageFiles(dir, relative));
    else files.push(relative);
  }
  return files;
}

function sameFileContents(a, b) {
  let statA;
  let statB;
  try {
    statA = fs.statSync(a);
    statB = fs.statSync(b);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
  return statB.isFile() && statA.size === statB.size && fileDigest(a, "sha256", "hex") === fileDigest(b, "sha256", "hex");
}

function fileDigest(file, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest(encoding);
}

function replaceFile(source, destination, fsApi) {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fsApi.mkdirSync(path.dirname(destination), { recursive: true });
    fsApi.copyFileSync(source, temporary);
    fsApi.renameSync(temporary, destination);
  } catch (error) {
    try {
      fsApi.rmSync(temporary, { force: true });
    } catch {
      // best effort; a leftover .tmp file is removed by the next sync
    }
    throw lockedFileError(error, destination);
  }
}

function lockedFileError(error, file) {
  if (!error || !LOCKED_FILE_CODES.has(error.code)) return error;
  const locked = new Error(
    `${file} could not be replaced (${error.code}: in use or not writable). ` +
    "Windows locks a loaded .node file while FlexDesigner runs the plugin: stop the plugin (or quit FlexDesigner), then build again."
  );
  locked.code = error.code;
  return locked;
}

function removeUnrequestedNativePackages(backendModules, keep, { fsApi = fs, log = () => {}, warn = log } = {}) {
  const scopeDir = path.join(backendModules, "@napi-rs");
  if (!fs.existsSync(scopeDir)) return;
  for (const entry of fs.readdirSync(scopeDir)) {
    const name = `@napi-rs/${entry}`;
    if (!entry.startsWith("canvas-") || keep.has(name)) continue;
    const dir = path.join(scopeDir, entry);
    try {
      // Binaries first: a locked one keeps the package whole instead of half-deleted.
      for (const file of listPackageFiles(dir).filter((item) => item.endsWith(".node"))) {
        fsApi.unlinkSync(path.join(dir, file));
      }
      fsApi.rmSync(dir, { recursive: true, force: true });
      log(`removed stale ${name} from the plugin backend`);
    } catch (error) {
      if (!error || !LOCKED_FILE_CODES.has(error.code)) throw error;
      warn(`could not remove stale ${name} (${error.code}: in use, e.g. by FlexDesigner); it stays in the plugin backend until a later build`);
    }
  }
}

/**
 * Provides <name>@<version> for a target npm did not install, extracted into a
 * fresh private temp dir. Returns { dir, source: "cache" | "npm pack", cleanup }.
 *
 * The tarball comes from `npm pack` (npm verifies it against the registry) and
 * must match the integrity package-lock.json records for the package. Only
 * tarballs with such a lockfile entry are cached (in node_modules/.cache), and
 * a cached tarball is re-verified against the lockfile every time it is used.
 */
function fetchNativePackage({
  name,
  version,
  projectDir,
  cacheDir = defaultCacheDir(projectDir),
  log = () => {},
  runNpm = runNpmCommand,
  integrity = lockfileIntegrity(projectDir, name, version),
}) {
  const cachedTarball = path.join(cacheDir, `${name.replace("/", "+")}-${version}.tgz`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-native-canvas-"));
  const cleanup = () => fs.rmSync(workDir, { recursive: true, force: true });
  try {
    let tarball = null;
    let source = "cache";
    if (integrity && fs.existsSync(cachedTarball)) {
      if (matchesIntegrity(cachedTarball, integrity)) {
        tarball = cachedTarball;
        log(`using cached ${name}@${version} (integrity matches package-lock.json)`);
      } else {
        log(`ignoring cached ${name}@${version}: it does not match the package-lock.json integrity`);
      }
    }
    if (!tarball) {
      source = "npm pack";
      log(`fetching ${name}@${version} with npm pack`);
      tarball = npmPack(name, version, workDir, projectDir, runNpm);
      if (integrity) {
        if (!matchesIntegrity(tarball, integrity)) {
          throw new Error(`npm pack ${name}@${version} does not match the integrity recorded in package-lock.json`);
        }
        storeInCache(tarball, cachedTarball, log);
      }
    }
    return { dir: extractNpmTarball(tarball, path.join(workDir, "package")), source, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function npmPack(name, version, workDir, projectDir, runNpm) {
  const packDir = path.join(workDir, "pack");
  fs.mkdirSync(packDir);
  runNpm(["pack", `${name}@${version}`, "--pack-destination", packDir, "--loglevel=error"], { cwd: projectDir || process.cwd() });
  const tarballs = fs.readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`npm pack ${name}@${version} produced ${tarballs.length} tarballs in ${packDir}`);
  }
  return path.join(packDir, tarballs[0]);
}

function storeInCache(tarball, cachedTarball, log) {
  const temporary = `${cachedTarball}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cachedTarball), { recursive: true });
    fs.copyFileSync(tarball, temporary);
    fs.renameSync(temporary, cachedTarball);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    log(`could not cache ${path.basename(cachedTarball)}: ${error.message}`);
  }
}

/** The integrity npm-shrinkwrap.json / package-lock.json records for name@version, or null. */
function lockfileIntegrity(projectDir, name, version) {
  if (!projectDir) return null;
  for (const lockfile of ["npm-shrinkwrap.json", "package-lock.json"]) {
    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(path.join(projectDir, lockfile), "utf8"));
    } catch {
      continue;
    }
    const entry = (lock.packages && lock.packages[`node_modules/${name}`]) || (lock.dependencies && lock.dependencies[name]);
    if (entry && entry.version === version && typeof entry.integrity === "string") return entry.integrity;
  }
  return null;
}

/** Checks a file against a Subresource Integrity string such as "sha512-<base64>". */
function matchesIntegrity(file, integrity) {
  return String(integrity).trim().split(/\s+/).some((item) => {
    const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)/.exec(item);
    return !!match && fileDigest(file, match[1], "base64") === match[2];
  });
}

/**
 * Runs npm with the given arguments. Output is captured and returned unless
 * `inherit` is set. Throws with npm's stderr when the command fails.
 */
function runNpmCommand(args, { cwd, env = process.env, inherit = false } = {}) {
  const options = { cwd, env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], encoding: "utf8" };
  // Prefer the npm that is running this build (`npm run build` sets npm_execpath);
  // it runs through node directly, which also avoids spawning npm.cmd on Windows.
  const npmCli = env.npm_execpath;
  try {
    if (npmCli && /npm-cli\.c?js$/.test(npmCli)) {
      return childProcess.execFileSync(process.execPath, [npmCli, ...args], options);
    }
    if (process.platform === "win32") {
      const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
      return childProcess.execFileSync("npm.cmd", quoted, { ...options, shell: true });
    }
    return childProcess.execFileSync("npm", args, options);
  } catch (error) {
    const detail = String((error && (error.stderr || error.message)) || error).trim();
    throw new Error(`npm ${args.join(" ")} failed: ${detail}`);
  }
}

/** Extracts a gzipped npm tarball, dropping its top-level "package/" directory. */
function extractNpmTarball(tarballPath, destination) {
  const data = zlib.gunzipSync(fs.readFileSync(tarballPath));
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });

  let offset = 0;
  let pendingPath = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const size = parseInt(tarField(header, 124, 12).trim() || "0", 8);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const prefix = tarField(header, 345, 155);
    const headerName = prefix ? `${prefix}/${tarField(header, 0, 100)}` : tarField(header, 0, 100);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      pendingPath = paxPath(body) || pendingPath;
      continue;
    }
    if (type === "L") {
      pendingPath = body.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    const entryName = pendingPath || headerName;
    pendingPath = null;
    if (type !== "0" && type !== "7") continue; // directories are created on demand; links are not expected

    const relative = entryName.split("/").slice(1).join("/");
    if (!relative) continue;
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new Error(`Refusing to extract ${entryName} outside ${root}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return root;
}

function tarField(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function paxPath(body) {
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
  return match ? match[1] : null;
}

module.exports = {
  CANVAS_PACKAGE,
  DESKTOP_TARGETS,
  NATIVE_CANVAS_TARGETS,
  TARGET_ALIASES,
  assertNativePackage,
  bundleNativeCanvas,
  defaultCacheDir,
  describeCopy,
  extractNpmTarball,
  fetchNativePackage,
  hostCanvasTarget,
  lockfileIntegrity,
  missingPackageFiles,
  nativeCanvasPackageName,
  resolveCanvasTargets,
  runNpmCommand,
  syncPackage,
};
