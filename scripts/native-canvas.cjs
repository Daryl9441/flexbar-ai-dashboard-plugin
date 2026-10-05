"use strict";

// Selects, fetches and bundles the @napi-rs/canvas native binaries that ship
// inside com.aspen.flexbar-ai-dashboard.plugin/backend/node_modules.
//
// npm only installs the native package for the machine running `npm install`,
// so a plugin built on one OS cannot render PNG keys on another unless the
// other platform's binary is fetched explicitly. FLEX_TARGET picks the
// platforms to bundle (default: the build host).

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const CANVAS_PACKAGE = "@napi-rs/canvas";

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
 * fetched with `npm pack` into a cache outside the project (no package.json,
 * lockfile or node_modules changes).
 */
function bundleNativeCanvas({
  projectDir,
  pluginDir,
  targets,
  cacheDir = defaultCacheDir(),
  fetchPackage = fetchNativePackage,
  log = () => {},
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

  const sources = targets.map((target) => {
    const name = nativeCanvasPackageName(target);
    if (!Object.prototype.hasOwnProperty.call(publishedNativePackages, name)) {
      throw new Error(`${CANVAS_PACKAGE}@${version} does not publish ${name} (target ${target})`);
    }
    const installedDir = packageDir(path.join(projectDir, "node_modules"), name);
    if (isUsableNativePackage(installedDir, name, version)) {
      return { target, name, dir: installedDir, source: "node_modules" };
    }
    const fetchedDir = fetchPackage({ name, version, cacheDir, projectDir, log });
    assertNativePackage(fetchedDir, name, version, target);
    return { target, name, dir: fetchedDir, source: "npm pack" };
  });

  const backendModules = path.join(pluginDir, "backend", "node_modules");
  copyPackage(canvasDir, packageDir(backendModules, CANVAS_PACKAGE));
  removeUnrequestedNativePackages(backendModules, new Set(sources.map((source) => source.name)), log);

  return sources.map((source) => {
    const destination = packageDir(backendModules, source.name);
    copyPackage(source.dir, destination);
    const binary = assertNativePackage(destination, source.name, version, source.target);
    return { ...source, version, binary, bytes: fs.statSync(binary).size };
  });
}

function defaultCacheDir() {
  return path.join(os.tmpdir(), "flexbar-ai-dashboard-native-canvas");
}

function packageDir(nodeModulesDir, packageName) {
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function nativeBinaryPath(dir, packageJson) {
  const main = packageJson && typeof packageJson.main === "string" ? packageJson.main : "";
  return main.endsWith(".node") ? path.join(dir, main) : null;
}

function isUsableNativePackage(dir, name, version) {
  const packageJson = readPackageJson(dir);
  if (!packageJson || packageJson.name !== name || packageJson.version !== version) return false;
  const binary = nativeBinaryPath(dir, packageJson);
  return !!binary && fs.existsSync(binary) && fs.statSync(binary).size > 0;
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
  return binary;
}

function copyPackage(source, destination) {
  try {
    fs.rmSync(destination, { recursive: true, force: true });
  } catch (error) {
    // Windows keeps a loaded .node file locked while FlexDesigner runs the plugin.
    if (error && error.code === "EPERM" && fs.existsSync(destination)) return;
    throw error;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function removeUnrequestedNativePackages(backendModules, keep, log) {
  const scopeDir = path.join(backendModules, "@napi-rs");
  if (!fs.existsSync(scopeDir)) return;
  for (const entry of fs.readdirSync(scopeDir)) {
    const name = `@napi-rs/${entry}`;
    if (!entry.startsWith("canvas-") || keep.has(name)) continue;
    fs.rmSync(path.join(scopeDir, entry), { recursive: true, force: true });
    log(`removed stale ${name} from the plugin backend`);
  }
}

/**
 * Downloads <name>@<version> with `npm pack` (integrity-checked against the
 * registry) and extracts it into cacheDir. Returns the extracted package dir.
 */
function fetchNativePackage({ name, version, cacheDir, projectDir, log = () => {}, runNpm = runNpmCommand }) {
  const destination = path.join(cacheDir, `${name.replace("/", "+")}@${version}`);
  if (isUsableNativePackage(destination, name, version)) return destination;

  fs.mkdirSync(cacheDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(cacheDir, "pack-"));
  try {
    log(`fetching ${name}@${version} with npm pack`);
    runNpm(["pack", `${name}@${version}`, "--pack-destination", workDir, "--loglevel=error"], { cwd: projectDir || process.cwd() });
    const tarballs = fs.readdirSync(workDir).filter((file) => file.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`npm pack ${name}@${version} produced ${tarballs.length} tarballs in ${workDir}`);
    }
    const staging = path.join(workDir, "package");
    extractNpmTarball(path.join(workDir, tarballs[0]), staging);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return destination;
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
  bundleNativeCanvas,
  extractNpmTarball,
  fetchNativePackage,
  hostCanvasTarget,
  nativeCanvasPackageName,
  resolveCanvasTargets,
  runNpmCommand,
};
