"use strict";

const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");

// Runs src/plugin.js in a child process against a fake FlexDesigner SDK. The Dots network client, sign-in reader,
// local cache, opener and renderer are fakes too (nothing touches the network, ~/.codex or the ChatGPT app); the
// renderer returns "dots:[kind,title,detail,hollow]". Timers of 10 s or more run 100x faster, so the 20 s / 90 s press
// refreshes fire after 200 / 900 ms and the ~150 s poll after 1350-1650 ms. DOTS_SCENARIO: { keys: [cid suffix],
// dots, cache?, snapshotDelayMs?, hostConfigs? (the host's getConfig() answers in turn: a config, or "reject"; {}
// once they run out), steps: [{ at, event, payload } | { at, tap: uid }], endAt }.
const FAKE_SDK_HOST = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const root = process.env.PLUGIN_ROOT;
const scenario = JSON.parse(process.env.DOTS_SCENARIO);
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-ai-dashboard-dots-"));
const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;
const out = { draws: [], renders: [], snapshotCalls: [], lists: [], opens: [], snackbars: [], homes: [], messages: [], logs: [] };
let snapshotReady = false;

const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 10_000 ? ms / 100 : ms, ...args);
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms, ...args) => realSetInterval(fn, Math.min(ms, 50), ...args);

function fake(file, exports) {
  const filename = require.resolve(file, { paths: [path.join(root, "src")] });
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}
const src = (...parts) => path.join(root, "src", ...parts);
const capture = (level) => (...args) => out.logs.push([level, ...args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))].join(" "));
const handlers = {};
fake("@eniac/flexdesigner", {
  logger: { info: capture("info"), warn: capture("warn"), error: capture("error"), debug() {} },
  plugin: {
    directory: pluginDir,
    on(type, handler) { handlers[type] = handler; },
    start() {},
    draw(serialNumber, key, type, image) {
      out.draws.push({ at: elapsed(), uid: key.uid, type, image: image || "draw:" + key.title });
      return Promise.resolve({});
    },
    getConfig() {
      const answers = scenario.hostConfigs || [];
      const answer = answers.length > 0 ? answers.shift() : {};
      return answer === "reject" ? Promise.reject(new Error("host busy")) : Promise.resolve(answer);
    },
    setConfig: () => Promise.resolve({}),
    showFlexbarSnackbarMessage(serialNumber, message, level) {
      out.snackbars.push({ message, level });
      return Promise.resolve({});
    },
  },
});
fake(src("collectors", "snapshot.js"), {
  collectAiSnapshot: async () => {
    out.snapshotCalls.push(elapsed());
    if (scenario.snapshotDelayMs) await new Promise((resolve) => realSetTimeout(resolve, scenario.snapshotDelayMs));
    snapshotReady = true;
    return { collectedAt: new Date().toISOString(), providers: { codex: { provider: "codex", sessions: [], activeSession: null, activity: { state: "idle" }, usage: null, quota: null } } };
  },
  compactSnapshot: (snapshot) => snapshot,
});
const fakeToken = ["ey", "J", "a".repeat(30), ".", "b".repeat(40), ".", "c".repeat(20)].join("");
fake(src("collectors", "dotsAuth.js"), {
  readDotsCredentials: (codexHome) => {
    out.homes.push([elapsed(), codexHome]);
    const credentials = { ok: true, expiresAt: Date.now() + 86_400_000, hasAccountId: true };
    Object.defineProperty(credentials, "accessToken", { value: fakeToken, enumerable: false });
    Object.defineProperty(credentials, "accountId", { value: "acct-" + "0".repeat(8), enumerable: false });
    return credentials;
  },
  isTokenExpired: () => false,
  decodeJwtPayload: () => null,
});
fake(src("collectors", "dotsLocalCache.js"), {
  STATE_FILE: ".codex-global-state.json",
  createDotsLocalCache: () => ({ read: () => scenario.cache || null }),
});
fake(src("collectors", "chatgptDots.js"), {
  createDotsClient: ({ onRequest }) => ({
    fetchList: async () => {
      out.lists.push(elapsed());
      onRequest({ kind: "list", route: "system-proxy", status: 200, category: null });
      return { ok: true, dots: scenario.dots };
    },
    fetchActivity: async () => {
      onRequest({ kind: "activity", route: "system-proxy", status: 200, category: null });
      return { ok: true, inProgress: 0 };
    },
  }),
});
fake(src("dashboard", "dotsAction.js"), {
  DOTS_DEEP_LINK: "codex://dots",
  openChatGptDots: async () => {
    out.opens.push(elapsed());
    return { ok: true, target: "app" };
  },
});
fake(src("dashboard", "dotsRender.js"), {
  renderDotsKey: (face) => {
    out.renders.push({ at: elapsed(), snapshotReady, kind: face.kind });
    return "dots:" + JSON.stringify([face.kind, face.title, face.detail, face.hollow]);
  },
});
const render = require(src("dashboard", "render.js"));
fake(src("dashboard", "render.js"), { ...render, renderSessionKey: () => "session", renderNewSessionKey: () => "new-session" });

require(src("plugin.js"));
const SERIAL = "001100AA0001";
const keys = scenario.keys.map((suffix, index) => ({
  uid: index + 1,
  cid: "com.aspen.flexbar-ai-dashboard." + suffix,
  width: 240,
  title: "x",
  style: {},
  data: suffix === "dots" ? { showName: true } : { sessionTitleMode: "initial" },
}));
handlers["plugin.alive"]({ serialNumber: SERIAL, keys });
for (const step of scenario.steps) {
  realSetTimeout(async () => {
    if (step.tap) {
      handlers["plugin.data"]({ serialNumber: SERIAL, data: { evt: "click", key: keys.find((key) => key.uid === step.tap) } });
      return;
    }
    const result = await handlers[step.event](step.payload);
    if (step.event === "ui.message") out.messages.push({ type: step.payload.type, result });
  }, step.at);
}
realSetTimeout(() => {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, scenario.endAt);
`;

function runDotsHost(scenario) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", FAKE_SDK_HOST], {
      encoding: "utf8",
      env: { ...process.env, PLUGIN_ROOT: path.join(__dirname, ".."), DOTS_SCENARIO: JSON.stringify(scenario) },
      timeout: 30_000,
    }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout))));
  });
}

const DOT = { id: "tbo~test-0001", name: "Test Dot", available: true, paused: false, safety: false, unread: false, latestAt: null, lastCheckInAt: null };
const IDLE_IMAGE = "dots:[\"idle\",\"Idle\",\"Test Dot\",false]";
const imagesOf = (out, uid) => out.draws.filter((draw) => draw.uid === uid).map((draw) => draw.image);
const SECRETS = [["ey", "J", "a".repeat(30)].join(""), "acct-" + "0".repeat(8), "tbo~test-0001", "Test Dot"];

test("a lone Dots key draws loading, then the polled state, without the Codex snapshot loop", async () => {
  const out = await runDotsHost({ keys: ["dots"], dots: [DOT], steps: [], endAt: 600 });
  const images = imagesOf(out, 1);
  assert.match(images[0], /^dots:\["loading"/);
  assert.equal(images.at(-1), IDLE_IMAGE);
  assert.deepEqual(out.snapshotCalls, [], "no 2-second Codex snapshot for a Dots key");
  assert.equal(out.lists.length, 1);
  assert.ok(out.logs.some((line) => /Dots status:/.test(line) && /"state":"idle"/.test(line)));
  const logText = out.logs.join("\n");
  for (const secret of SECRETS) assert.ok(!logText.includes(secret), `the log leaks ${secret.slice(0, 6)}`);
});

test("next to an AI Session key, Dots is drawn before and after the first snapshot", async () => {
  const out = await runDotsHost({ keys: ["dots", "session"], dots: [DOT], snapshotDelayMs: 200, steps: [], endAt: 600 });
  assert.ok(out.snapshotCalls.length > 0, "the session key still runs the snapshot loop");
  assert.ok(out.renders.some((item) => !item.snapshotReady), "drawn while there is no snapshot yet");
  assert.ok(out.renders.some((item) => item.snapshotReady && item.kind === "idle"), "drawn with the snapshot too");
  assert.equal(imagesOf(out, 1).at(-1), IDLE_IMAGE);
});

test("tapping opens Dots once per 1.5 s, shows a snackbar and refreshes 20 s and 90 s later", async () => {
  const out = await runDotsHost({ keys: ["dots"], dots: [DOT], steps: [{ at: 200, tap: 1 }, { at: 500, tap: 1 }], endAt: 1_300 });
  assert.equal(out.opens.length, 1);
  assert.deepEqual(out.snackbars, [{ message: "Opening ChatGPT Dots", level: "success" }]);
  assert.equal(out.lists.length, 3, JSON.stringify(out.lists));
  assert.ok(out.lists[1] >= 380 && out.lists[1] < 700, `first refresh at ${out.lists[1]}`);
  assert.ok(out.lists[2] >= 1_080, `second refresh at ${out.lists[2]}`);
  assert.deepEqual(out.snapshotCalls, []);
});

test("a Codex home pushed by the host is asked at once, not at the next poll", async () => {
  const otherHome = os.tmpdir();
  const out = await runDotsHost({
    keys: ["dots"],
    dots: [DOT],
    steps: [{ at: 300, event: "plugin.config.updated", payload: { config: { pathOverrides: { CODEX_HOME: otherHome } } } }],
    endAt: 800,
  });
  // The regular poll after the first round comes at 1350-1650 ms: only an immediate refresh asks before 800 ms.
  assert.equal(out.lists.filter((at) => at >= 300).length, 1, JSON.stringify(out.lists));
  assert.ok(out.lists.at(-1) < 450, `asked at ${out.lists.at(-1)}`);
  assert.ok(out.homes.some(([at, home]) => at >= 300 && at < 450 && home === otherHome));
});

test("a host config that arrives late is applied at once", async () => {
  const otherHome = os.tmpdir();
  // The first getConfig() fails, so the first round uses the plugin's own config; the settings page asks again later.
  const homeOut = await runDotsHost({
    keys: ["dots"],
    dots: [DOT],
    hostConfigs: ["reject", { pathOverrides: { CODEX_HOME: otherHome } }],
    steps: [{ at: 300, event: "ui.message", payload: { type: "dotsStatus" } }],
    endAt: 800,
  });
  assert.equal(homeOut.lists.length, 2, JSON.stringify(homeOut.lists));
  assert.ok(homeOut.lists[1] >= 300 && homeOut.lists[1] < 450, `asked at ${homeOut.lists[1]}`);
  assert.ok(homeOut.homes.some(([at, home]) => at >= 300 && at < 450 && home === otherHome));

  const localOut = await runDotsHost({
    keys: ["dots"],
    dots: [DOT],
    cache: { dots: [{ ...DOT, paused: true }], activity: {}, updatedAt: Date.now() },
    hostConfigs: ["reject", { dotsStatusSource: "local" }],
    steps: [{ at: 300, event: "ui.message", payload: { type: "dotsStatus" } }],
    endAt: 800,
  });
  assert.equal(localOut.lists.length, 1, "no request once the host says local");
  const pausedAt = localOut.draws.filter((draw) => draw.uid === 1 && draw.image.startsWith("dots:[\"paused\"")).map((draw) => draw.at);
  assert.ok(pausedAt.length > 0 && pausedAt[0] >= 300 && pausedAt[0] < 450, `cache drawn at ${pausedAt[0]}`);
});

test("switching to local status stops the requests; switching back asks again", async () => {
  const otherHome = os.tmpdir();
  const out = await runDotsHost({
    keys: ["dots"],
    dots: [DOT],
    cache: { dots: [{ ...DOT, paused: true }], activity: {}, updatedAt: Date.now() },
    steps: [
      { at: 150, event: "ui.message", payload: { type: "savePluginConfig", config: { pathOverrides: { CODEX_HOME: "" }, dotsStatusSource: "local" } } },
      { at: 300, event: "ui.message", payload: { type: "dotsStatus" } },
      { at: 450, event: "plugin.config.updated", payload: { config: { pathOverrides: { CODEX_HOME: otherHome }, dotsStatusSource: "auto" } } },
    ],
    endAt: 700,
  });
  assert.deepEqual(out.lists.filter((at) => at >= 150 && at < 450), [], "no request in local mode");
  assert.equal(out.lists.filter((at) => at >= 450).length, 1, "the new home is asked at once");
  assert.ok(out.homes.some(([at, home]) => at >= 450 && home === otherHome));
  const status = out.messages.find((message) => message.type === "dotsStatus").result;
  assert.deepEqual(Object.keys(status).sort(), ["degraded", "source", "state", "updatedAt"]);
  assert.deepEqual([status.state, status.source, status.degraded], ["paused", "cache", true]);
  assert.ok(imagesOf(out, 1).some((image) => image.startsWith("dots:[\"paused\"")));
});

test("removing the key stops the poller and its pending refreshes", async () => {
  const out = await runDotsHost({
    keys: ["dots"],
    dots: [DOT],
    steps: [
      { at: 100, tap: 1 },
      { at: 200, event: "plugin.dead", payload: { serialNumber: "001100AA0001", keys: [{ uid: 1 }] } },
    ],
    endAt: 1_300,
  });
  assert.equal(out.opens.length, 1);
  assert.deepEqual(out.lists.filter((at) => at >= 200), []);
});

test("while every Flexbar is unplugged the poller waits", async () => {
  const out = await runDotsHost({
    keys: ["dots"],
    dots: [DOT],
    steps: [
      { at: 100, event: "device.status", payload: [{ serialNumber: "001100AA0001", status: "disconnected", _removeDevice: true }] },
      { at: 150, tap: 1 },
    ],
    endAt: 800,
  });
  assert.equal(out.lists.length, 1, "the press refresh at +200 ms did not run");
});
