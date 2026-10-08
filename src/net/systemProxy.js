"use strict";

// Picks how the Dots status requests reach chatgpt.com: through the proxy named by HTTPS_PROXY, else through the
// macOS system proxy (`scutil --proxy`), else directly. The tunnel itself is Node's built-in one: an https.Agent
// with `proxyEnv` sends CONNECT to the proxy (Node 22.21+ / 24.5+; FlexDesigner's runtime is Node 22.22), so this
// module only has to name the proxy. A PAC configuration is treated as "no proxy".

const { execFile } = require("node:child_process");
const https = require("node:https");

const ROUTE = Object.freeze({ ENV: "env-proxy", SYSTEM: "system-proxy", DIRECT: "direct" });
const SCUTIL_PATH = "/usr/sbin/scutil";
const SCUTIL_TIMEOUT_MS = 2_000;
const SCUTIL_CACHE_MS = 60_000;
const DIRECT_ROUTE = Object.freeze({ type: ROUTE.DIRECT, proxyUrl: null });

/** `scutil --proxy` output -> { proxyUrl: "http://host:port" | null, exceptions: [...] }. Never throws. */
function parseScutilProxy(text) {
  const values = {};
  const exceptions = [];
  let inExceptions = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inExceptions) {
      if (line === "}") {
        inExceptions = false;
        continue;
      }
      const entry = /^\d+\s*:\s*(.+)$/.exec(line);
      if (entry) exceptions.push(entry[1].trim());
      continue;
    }
    if (/^ExceptionsList\s*:\s*<array>\s*\{$/.test(line)) {
      inExceptions = true;
      continue;
    }
    const pair = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(line);
    if (pair) values[pair[1]] = pair[2].trim();
  }
  return { proxyUrl: scutilHttpsProxyUrl(values), exceptions };
}

function scutilHttpsProxyUrl(values) {
  if (values.HTTPSEnable !== "1") return null;
  const host = values.HTTPSProxy;
  const port = Number(values.HTTPSPort);
  if (!host || /[\s/@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** The http(s) proxy URL in HTTPS_PROXY / https_proxy, or null (other schemes such as socks5 are not used). */
function envProxyUrl(env = process.env) {
  const value = String(env.HTTPS_PROXY || env.https_proxy || "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function envNoProxy(env = process.env) {
  return String(env.NO_PROXY || env.no_proxy || "").split(/[\s,]+/).filter(Boolean);
}

/** Whether `host` matches a NO_PROXY / exception list ("*", "host", ".domain", "*.domain", "host:port"). */
function matchesNoProxy(host, entries) {
  const target = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!target) return false;
  return (entries || []).some((raw) => {
    let entry = String(raw || "").trim().toLowerCase();
    if (entry === "*") return true;
    if (!entry || entry.includes("/") || entry.startsWith("<")) return false;
    entry = entry.replace(/:\d+$/, "");
    if (entry.startsWith("*.")) entry = entry.slice(1);
    const domain = entry.startsWith(".") ? entry.slice(1) : entry;
    return target === domain || target.endsWith(`.${domain}`);
  });
}

/** Node versions whose https.Agent accepts `proxyEnv` (22.21+, 24.5+, 25+). */
function supportsProxyEnv(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\./.exec(String(version || ""));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major >= 25;
}

/** Text of `scutil --proxy`, or "" when it cannot be run. Never rejects. */
function readScutilProxy(execFileImpl = execFile) {
  return new Promise((resolve) => {
    try {
      execFileImpl(SCUTIL_PATH, ["--proxy"], { timeout: SCUTIL_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        resolve(error ? "" : String(stdout || ""));
      });
    } catch {
      resolve("");
    }
  });
}

/**
 * Resolves the route to a host: { type: "env-proxy" | "system-proxy" | "direct", proxyUrl }. The system proxy is
 * read at most once a minute. A runtime without `proxyEnv` support always connects directly.
 */
function createProxyResolver(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const readScutil = options.readScutil || (() => readScutilProxy());
  const now = typeof options.now === "function" ? options.now : Date.now;
  const proxySupported = options.proxySupported === undefined ? supportsProxyEnv() : Boolean(options.proxySupported);
  let cached = null;

  async function systemProxy() {
    const time = now();
    if (cached && time - cached.at < SCUTIL_CACHE_MS) return cached.value;
    let value;
    try {
      value = parseScutilProxy(await readScutil());
    } catch {
      value = parseScutilProxy("");
    }
    cached = { at: time, value };
    return value;
  }

  return {
    async resolve(host) {
      if (!proxySupported) return DIRECT_ROUTE;
      const fromEnv = envProxyUrl(env);
      if (fromEnv) {
        return matchesNoProxy(host, envNoProxy(env)) ? DIRECT_ROUTE : { type: ROUTE.ENV, proxyUrl: fromEnv };
      }
      if (platform !== "darwin") return DIRECT_ROUTE;
      const system = await systemProxy();
      if (system.proxyUrl && !matchesNoProxy(host, system.exceptions)) {
        return { type: ROUTE.SYSTEM, proxyUrl: system.proxyUrl };
      }
      return DIRECT_ROUTE;
    },
    clear() {
      cached = null;
    },
  };
}

/**
 * A fresh agent for one request: tunnelled through the route's proxy, or direct. Never the global agent, which
 * NODE_USE_ENV_PROXY may have pointed at a proxy of its own.
 */
function createRouteAgent(route) {
  if (route && route.proxyUrl) return new https.Agent({ proxyEnv: { HTTPS_PROXY: route.proxyUrl } });
  return new https.Agent({});
}

module.exports = {
  ROUTE,
  createProxyResolver,
  createRouteAgent,
  envNoProxy,
  envProxyUrl,
  matchesNoProxy,
  parseScutilProxy,
  readScutilProxy,
  supportsProxyEnv,
};
