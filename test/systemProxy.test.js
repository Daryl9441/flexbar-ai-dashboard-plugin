"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");

const {
  ROUTE,
  createProxyResolver,
  createRouteAgent,
  envNoProxy,
  envProxyUrl,
  matchesNoProxy,
  parseScutilProxy,
  readScutilProxy,
  supportsProxyEnv,
} = require("../src/net/systemProxy");

// What `scutil --proxy` prints on macOS with a local HTTP(S) proxy (documentation addresses only).
const SCUTIL_ENABLED = [
  "<dictionary> {",
  "  ExceptionsList : <array> {",
  "    0 : 127.0.0.1",
  "    1 : 192.168.0.0/16",
  "    2 : localhost",
  "    3 : *.local",
  "    4 : <local>",
  "  }",
  "  HTTPEnable : 1",
  "  HTTPPort : 8080",
  "  HTTPProxy : 127.0.0.1",
  "  HTTPSEnable : 1",
  "  HTTPSPort : 7890",
  "  HTTPSProxy : 127.0.0.1",
  "  ProxyAutoConfigEnable : 0",
  "  SOCKSEnable : 1",
  "  SOCKSPort : 7891",
  "  SOCKSProxy : 127.0.0.1",
  "}",
].join("\n");

test("parseScutilProxy reads the HTTPS proxy and the exception list", () => {
  assert.deepEqual(parseScutilProxy(SCUTIL_ENABLED), {
    proxyUrl: "http://127.0.0.1:7890",
    exceptions: ["127.0.0.1", "192.168.0.0/16", "localhost", "*.local", "<local>"],
  });
});

test("parseScutilProxy ignores a disabled, incomplete or PAC-only proxy and garbage", () => {
  const disabled = SCUTIL_ENABLED.replace("HTTPSEnable : 1", "HTTPSEnable : 0");
  assert.equal(parseScutilProxy(disabled).proxyUrl, null);
  assert.equal(parseScutilProxy(SCUTIL_ENABLED.replace("  HTTPSPort : 7890\n", "")).proxyUrl, null);
  assert.equal(parseScutilProxy(SCUTIL_ENABLED.replace("HTTPSPort : 7890", "HTTPSPort : 70000")).proxyUrl, null);
  assert.equal(parseScutilProxy(SCUTIL_ENABLED.replace("HTTPSProxy : 127.0.0.1", "HTTPSProxy : bad host")).proxyUrl, null);
  const pacOnly = "<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://example.com/proxy.pac\n}";
  assert.deepEqual(parseScutilProxy(pacOnly), { proxyUrl: null, exceptions: [] });
  assert.deepEqual(parseScutilProxy(""), { proxyUrl: null, exceptions: [] });
  assert.deepEqual(parseScutilProxy(undefined), { proxyUrl: null, exceptions: [] });
});

test("parseScutilProxy brackets an IPv6 proxy host", () => {
  const text = "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 3128\n  HTTPSProxy : ::1\n}";
  assert.equal(parseScutilProxy(text).proxyUrl, "http://[::1]:3128");
});

test("matchesNoProxy handles wildcards, domain suffixes, ports and case", () => {
  assert.equal(matchesNoProxy("chatgpt.com", ["*"]), true);
  assert.equal(matchesNoProxy("chatgpt.com", ["chatgpt.com"]), true);
  assert.equal(matchesNoProxy("ChatGPT.com.", ["CHATGPT.COM"]), true);
  assert.equal(matchesNoProxy("chatgpt.com", ["chatgpt.com:443"]), true);
  assert.equal(matchesNoProxy("api.chatgpt.com", [".chatgpt.com"]), true);
  assert.equal(matchesNoProxy("chatgpt.com", [".chatgpt.com"]), true);
  assert.equal(matchesNoProxy("api.chatgpt.com", ["*.chatgpt.com"]), true);
  assert.equal(matchesNoProxy("api.chatgpt.com", ["chatgpt.com"]), true);
  assert.equal(matchesNoProxy("notchatgpt.com", ["chatgpt.com"]), false);
  assert.equal(matchesNoProxy("chatgpt.com", ["localhost", "*.local", "<local>", "10.0.0.0/8", ""]), false);
  assert.equal(matchesNoProxy("chatgpt.com", []), false);
});

test("envProxyUrl accepts http(s) proxies from HTTPS_PROXY or https_proxy only", () => {
  assert.equal(envProxyUrl({ HTTPS_PROXY: " http://127.0.0.1:7890 " }), "http://127.0.0.1:7890");
  assert.equal(envProxyUrl({ https_proxy: "http://127.0.0.1:7890" }), "http://127.0.0.1:7890");
  assert.equal(envProxyUrl({ HTTPS_PROXY: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:2" }), "http://127.0.0.1:1");
  assert.equal(envProxyUrl({ HTTPS_PROXY: "socks5://127.0.0.1:7891" }), null);
  assert.equal(envProxyUrl({ HTTPS_PROXY: "not a url" }), null);
  assert.equal(envProxyUrl({ HTTP_PROXY: "http://127.0.0.1:7890", ALL_PROXY: "http://127.0.0.1:7890" }), null);
  assert.equal(envProxyUrl({}), null);
  assert.deepEqual(envNoProxy({ NO_PROXY: "localhost, .example.com  chatgpt.com" }), ["localhost", ".example.com", "chatgpt.com"]);
  assert.deepEqual(envNoProxy({ no_proxy: "a.test" }), ["a.test"]);
  assert.deepEqual(envNoProxy({}), []);
});

test("the resolver prefers the environment proxy, then the macOS system proxy, then a direct connection", async () => {
  let scutilReads = 0;
  const readScutil = async () => {
    scutilReads += 1;
    return SCUTIL_ENABLED;
  };

  const fromEnv = createProxyResolver({ env: { HTTPS_PROXY: "http://127.0.0.1:9000" }, platform: "darwin", readScutil, proxySupported: true });
  assert.deepEqual(await fromEnv.resolve("chatgpt.com"), { type: ROUTE.ENV, proxyUrl: "http://127.0.0.1:9000" });
  assert.equal(scutilReads, 0, "the system proxy is not read when the environment names one");

  const envBypass = createProxyResolver({
    env: { HTTPS_PROXY: "http://127.0.0.1:9000", NO_PROXY: ".chatgpt.com" },
    platform: "darwin",
    readScutil,
    proxySupported: true,
  });
  assert.deepEqual(await envBypass.resolve("chatgpt.com"), { type: ROUTE.DIRECT, proxyUrl: null });

  const system = createProxyResolver({ env: {}, platform: "darwin", readScutil, proxySupported: true });
  assert.deepEqual(await system.resolve("chatgpt.com"), { type: ROUTE.SYSTEM, proxyUrl: "http://127.0.0.1:7890" });
  assert.deepEqual(await system.resolve("localhost"), { type: ROUTE.DIRECT, proxyUrl: null }, "exception list");

  const windows = createProxyResolver({ env: {}, platform: "win32", readScutil, proxySupported: true });
  assert.deepEqual(await windows.resolve("chatgpt.com"), { type: ROUTE.DIRECT, proxyUrl: null });

  const failing = createProxyResolver({ env: {}, platform: "darwin", readScutil: async () => "", proxySupported: true });
  assert.deepEqual(await failing.resolve("chatgpt.com"), { type: ROUTE.DIRECT, proxyUrl: null });

  const unsupported = createProxyResolver({ env: { HTTPS_PROXY: "http://127.0.0.1:9000" }, platform: "darwin", readScutil, proxySupported: false });
  assert.deepEqual(await unsupported.resolve("chatgpt.com"), { type: ROUTE.DIRECT, proxyUrl: null }, "a runtime without proxyEnv connects directly");
});

test("the resolver caches the system proxy for a minute", async () => {
  let time = 1_000_000;
  let reads = 0;
  const resolver = createProxyResolver({
    env: {},
    platform: "darwin",
    now: () => time,
    readScutil: async () => {
      reads += 1;
      return SCUTIL_ENABLED;
    },
    proxySupported: true,
  });
  await resolver.resolve("chatgpt.com");
  time += 59_000;
  await resolver.resolve("chatgpt.com");
  assert.equal(reads, 1);
  time += 2_000;
  await resolver.resolve("chatgpt.com");
  assert.equal(reads, 2);
  resolver.clear();
  await resolver.resolve("chatgpt.com");
  assert.equal(reads, 3);
});

test("readScutilProxy runs /usr/sbin/scutil --proxy and yields empty text on failure", async () => {
  const calls = [];
  const ok = await readScutilProxy((file, args, options, callback) => {
    calls.push({ file, args, timeout: options.timeout });
    callback(null, SCUTIL_ENABLED);
  });
  assert.equal(ok, SCUTIL_ENABLED);
  assert.deepEqual(calls, [{ file: "/usr/sbin/scutil", args: ["--proxy"], timeout: 2_000 }]);

  const failed = await readScutilProxy((file, args, options, callback) => callback(new Error("ENOENT")));
  assert.equal(failed, "");
  const thrown = await readScutilProxy(() => {
    throw new Error("spawn failed");
  });
  assert.equal(thrown, "");
});

test("supportsProxyEnv knows which Node versions have the built-in https.Agent proxy", () => {
  assert.equal(supportsProxyEnv("22.22.0"), true);
  assert.equal(supportsProxyEnv("22.21.1"), true);
  assert.equal(supportsProxyEnv("22.20.0"), false);
  assert.equal(supportsProxyEnv("24.5.0"), true);
  assert.equal(supportsProxyEnv("24.4.1"), false);
  assert.equal(supportsProxyEnv("25.0.0"), true);
  assert.equal(supportsProxyEnv("23.11.0"), false);
  assert.equal(supportsProxyEnv("20.18.0"), false);
  assert.equal(supportsProxyEnv("garbage"), false);
});

test("createRouteAgent builds a fresh https.Agent per route", () => {
  const direct = createRouteAgent({ type: ROUTE.DIRECT, proxyUrl: null });
  const proxied = createRouteAgent({ type: ROUTE.SYSTEM, proxyUrl: "http://127.0.0.1:7890" });
  assert.ok(direct instanceof https.Agent);
  assert.ok(proxied instanceof https.Agent);
  assert.notEqual(direct, proxied);
  assert.notEqual(direct, https.globalAgent, "never the global agent, which NODE_USE_ENV_PROXY may reconfigure");
});
