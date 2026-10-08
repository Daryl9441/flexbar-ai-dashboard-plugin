"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  DOTS_LIST_URL,
  activityUrl,
  assertAllowedRequest,
  buildDotsHeaders,
  classifyResponse,
  createDotsClient,
  parseRetryAfter,
} = require("../src/collectors/chatgptDots");
const { ROUTE, createRouteAgent, supportsProxyEnv } = require("../src/net/systemProxy");

// Fake credentials and ids, assembled at runtime.
const FAKE_TOKEN = ["ey", "J", "a".repeat(30), ".", "b".repeat(40), ".", "c".repeat(20)].join("");
const FAKE_ACCOUNT = "acct-" + "0".repeat(8);
const TBO_ID = "tbo~test-0001";
const DOT_NAME = "Test Dot";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const SECRETS = [FAKE_TOKEN, FAKE_ACCOUNT, TBO_ID, DOT_NAME];

function credentials({ expiresAt = NOW + 3_600_000, accountId = FAKE_ACCOUNT } = {}) {
  const value = { ok: true, expiresAt, hasAccountId: Boolean(accountId) };
  Object.defineProperties(value, {
    accessToken: { value: FAKE_TOKEN, enumerable: false },
    accountId: { value: accountId, enumerable: false },
  });
  return value;
}

function json(status, body, extra = {}) {
  return { status, contentType: "application/json", isJson: true, json: body, retryAfter: null, cfMitigated: null, ...extra };
}

function html(status, extra = {}) {
  return { status, contentType: "text/html", isJson: false, json: null, retryAfter: null, cfMitigated: null, ...extra };
}

function listBody() {
  return {
    items: [{
      id: TBO_ID,
      display_name: DOT_NAME,
      status: "active",
      is_paused: false,
      messaging_room_preview: { message_preview: { latest_item_timestamp: "2026-10-08T11:00:00Z" }, last_read_at: null },
    }],
    cursor: null,
  };
}

// A client whose getJson replays `answers` (a response object, or an Error to reject with) and records each call.
function fakeClient(answers, { route = { type: ROUTE.SYSTEM, proxyUrl: "http://127.0.0.1:7890" } } = {}) {
  const calls = [];
  const events = [];
  const queue = [...answers];
  const client = createDotsClient({
    resolveRoute: async () => route,
    createAgent: (agentRoute) => ({ agentFor: agentRoute.type }),
    getJson: async (params) => {
      calls.push(params);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => NOW,
    onRequest: (event) => events.push(event),
  });
  return { client, calls, events };
}

function requestError(code, beforeResponse = true) {
  return Object.assign(new Error(`HTTPS request failed (${code})`), { code, beforeResponse });
}

test("only GET requests to the two read-only Dots paths on chatgpt.com pass the allowlist", () => {
  assert.doesNotThrow(() => assertAllowedRequest("GET", DOTS_LIST_URL));
  assert.doesNotThrow(() => assertAllowedRequest("GET", activityUrl(TBO_ID)));
  assert.doesNotThrow(() => assertAllowedRequest("get", "https://chatgpt.com/backend-api/tbo"));

  const refused = [
    ["POST", DOTS_LIST_URL],
    ["PUT", DOTS_LIST_URL],
    ["PATCH", DOTS_LIST_URL],
    ["DELETE", activityUrl(TBO_ID)],
    ["HEAD", DOTS_LIST_URL],
    ["GET", "http://chatgpt.com/backend-api/tbo"],
    ["GET", "https://api.openai.com/backend-api/tbo"],
    ["GET", "https://sub.chatgpt.com/backend-api/tbo"],
    ["GET", "https://chatgpt.com.example.test/backend-api/tbo"],
    ["GET", "https://chatgpt.com:8443/backend-api/tbo"],
    ["GET", ["https://user:pw", "@chatgpt.com/backend-api/tbo"].join("")],
    ["GET", "https://chatgpt.com/backend-api/tbo/primary"],
    ["GET", `https://chatgpt.com/backend-api/tbo/${TBO_ID}`],
    ["GET", `https://chatgpt.com/backend-api/tbo/${TBO_ID}/runtime/pause`],
    ["GET", `https://chatgpt.com/backend-api/tbo/${TBO_ID}/activity/stream`],
    ["GET", `https://chatgpt.com/backend-api/tbo/${TBO_ID}/automations`],
    ["GET", "https://chatgpt.com/backend-api/messaging/rooms/room-test-0001"],
    ["GET", "https://chatgpt.com/backend-api/wham/usage"],
    ["GET", "https://chatgpt.com/backend-api/tbo/../wham/activity"],
    ["GET", "not a url"],
  ];
  for (const [method, url] of refused) {
    assert.throws(() => assertAllowedRequest(method, url), (error) => {
      assert.match(error.message, /^Dots request not allowed/);
      assert.ok(!error.message.includes(TBO_ID), "the message never quotes the URL");
      return true;
    }, `${method} ${url}`);
  }
});

test("request URLs are exact, and a dot id keeps its '~'", () => {
  assert.equal(DOTS_LIST_URL, "https://chatgpt.com/backend-api/tbo?limit=25&include_room_preview=true");
  assert.equal(activityUrl(TBO_ID), "https://chatgpt.com/backend-api/tbo/tbo~test-0001/activity?limit=5");
  assert.equal(activityUrl("a/b"), "https://chatgpt.com/backend-api/tbo/a%2Fb/activity?limit=5");
  for (const bad of ["", ".", "..", null, 42]) assert.throws(() => activityUrl(bad), /Dots request not allowed/);
});

test("headers carry the bearer token, the account id and nothing else", () => {
  assert.deepEqual(buildDotsHeaders(credentials()), {
    Authorization: `Bearer ${FAKE_TOKEN}`,
    "ChatGPT-Account-Id": FAKE_ACCOUNT,
    Accept: "application/json",
    "User-Agent": "codex-cli",
  });
  assert.equal(buildDotsHeaders(credentials({ accountId: null }))["ChatGPT-Account-Id"], undefined);
});

test("responses are classified into the key's error categories", () => {
  const live = { tokenExpired: false, now: NOW };
  assert.deepEqual(classifyResponse(json(200, {}), live), { ok: true });
  assert.deepEqual(classifyResponse(html(200), live), { ok: false, category: "blocked", status: 200, retryAfterMs: null });
  assert.equal(classifyResponse(json(401, { detail: "x" }), live).category, "authRejected");
  assert.equal(classifyResponse(json(401, { detail: "x" }), { tokenExpired: true, now: NOW }).category, "authExpired");
  assert.equal(classifyResponse(html(401), live).category, "authRejected");
  assert.equal(classifyResponse(json(403, { detail: "Forbidden" }), live).category, "noAccess");
  assert.equal(classifyResponse(html(403), live).category, "blocked", "an HTML 403 is a block page, never 'no access'");
  assert.equal(classifyResponse(json(403, {}, { cfMitigated: "challenge" }), live).category, "blocked");
  assert.equal(classifyResponse(json(404, { detail: "Not Found" }), live).category, "noAccess");
  assert.equal(classifyResponse(html(404), live).category, "blocked");
  assert.deepEqual(classifyResponse(json(429, {}, { retryAfter: "120" }), live), { ok: false, category: "rateLimited", status: 429, retryAfterMs: 120_000 });
  assert.equal(classifyResponse(html(429), live).retryAfterMs, null);
  for (const status of [500, 502, 503, 504]) assert.equal(classifyResponse(html(status), live).category, "server");
  assert.equal(classifyResponse(json(400, {}), live).category, "badResponse");
});

test("Retry-After is read as seconds or an HTTP date", () => {
  assert.equal(parseRetryAfter("30", NOW), 30_000);
  assert.equal(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW), 90_000);
  assert.equal(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW), 0);
  assert.equal(parseRetryAfter("soon", NOW), null);
  assert.equal(parseRetryAfter(null, NOW), null);
  assert.equal(parseRetryAfter("-3", NOW), null);
});

test("the list request sends one GET with the headers and returns normalized dots", async () => {
  const { client, calls, events } = fakeClient([json(200, listBody())]);
  const result = await client.fetchList(credentials());

  assert.equal(result.ok, true);
  assert.deepEqual(result.dots.map((dot) => [dot.id, dot.name, dot.unread]), [[TBO_ID, DOT_NAME, true]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DOTS_LIST_URL);
  assert.deepEqual(calls[0].headers, buildDotsHeaders(credentials()));
  assert.deepEqual(calls[0].agent, { agentFor: ROUTE.SYSTEM });
  assert.equal(calls[0].timeoutMs, 8_000);
  assert.equal(calls[0].maxBytes, 512 * 1024);
  assert.equal(calls[0].method, undefined, "the transport only ever sends GET");
  assert.deepEqual(events, [{ kind: "list", route: ROUTE.SYSTEM, status: 200, category: null }]);
});

test("a list body without items, or a JSON 403, is reported, not shown as 'no dot'", async () => {
  const bad = await fakeClient([json(200, { detail: "x" })]).client.fetchList(credentials());
  assert.deepEqual(bad, { ok: false, category: "badResponse", status: 200, retryAfterMs: null });

  const denied = await fakeClient([json(403, { detail: "x" })]).client.fetchList(credentials());
  assert.equal(denied.category, "noAccess");
});

test("401 is 'expired' only once the token's exp has passed", async () => {
  const rejected = await fakeClient([json(401, {})]).client.fetchList(credentials());
  assert.equal(rejected.category, "authRejected");
  const expired = await fakeClient([json(401, {})]).client.fetchList(credentials({ expiresAt: NOW - 1_000 }));
  assert.equal(expired.category, "authExpired");
});

test("a proxy that cannot be reached falls back to one direct attempt", async () => {
  const { client, calls, events } = fakeClient([requestError("ERR_PROXY_TUNNEL"), json(200, listBody())]);
  const result = await client.fetchList(credentials());

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.agent.agentFor), [ROUTE.SYSTEM, ROUTE.DIRECT]);
  assert.deepEqual(events, [
    { kind: "list", route: ROUTE.SYSTEM, status: null, category: "network" },
    { kind: "list", route: "direct-fallback", status: 200, category: null },
  ]);

  for (const code of ["ERR_PROXY_TUNNEL", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]) {
    const retried = fakeClient([requestError(code), requestError("ECONNREFUSED")]);
    const failed = await retried.client.fetchList(credentials());
    assert.equal(failed.category, "network");
    assert.equal(retried.calls.length, 2, `${code}: one direct retry, no more`);
  }
});

test("a reset tunnel is not retried directly: the proxy may have accepted it already", async () => {
  // Node reports ECONNRESET both for a proxy that resets before answering CONNECT and for a tunnel it accepted and
  // dropped later (its upstream failed, or a REJECT rule): the token must not go around the proxy in that case.
  const reset = fakeClient([requestError("ECONNRESET"), json(200, listBody())]);
  assert.equal((await reset.client.fetchList(credentials())).category, "network");
  assert.equal(reset.calls.length, 1);
  assert.deepEqual(reset.events, [{ kind: "list", route: ROUTE.SYSTEM, status: null, category: "network" }]);
});

test("a local proxy that accepts the tunnel and then closes it gets no direct retry", { skip: !supportsProxyEnv() }, async (t) => {
  const proxy = http.createServer();
  const connects = [];
  const sockets = new Set();
  proxy.on("connect", (req, socket) => {
    connects.push(req.url);
    sockets.add(socket);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    setTimeout(() => socket.end(), 20);
  });
  // A socket handed over by "connect" is no longer the server's: close() would wait for it forever.
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

  const directAgents = [];
  const client = createDotsClient({
    resolveRoute: async () => ({ type: ROUTE.SYSTEM, proxyUrl: `http://127.0.0.1:${proxy.address().port}` }),
    // A direct attempt would leave the machine: record it and refuse to build its agent instead.
    createAgent: (route) => {
      if (route.proxyUrl) return createRouteAgent(route);
      directAgents.push(route.type);
      throw new Error("direct attempt blocked by the test");
    },
    now: () => NOW,
  });
  const result = await client.fetchList(credentials());
  assert.equal(result.category, "network");
  assert.deepEqual(connects, ["chatgpt.com:443"]);
  assert.deepEqual(directAgents, [], "no direct attempt after the proxy accepted the tunnel");
});

test("no fallback after a response started, on a timeout, or when already direct", async () => {
  const late = fakeClient([requestError("ERESPONSETOOLARGE", false)]);
  assert.equal((await late.client.fetchList(credentials())).category, "network");
  assert.equal(late.calls.length, 1);

  const timeout = fakeClient([requestError("ETIMEDOUT")]);
  await timeout.client.fetchList(credentials());
  assert.equal(timeout.calls.length, 1);

  const direct = fakeClient([requestError("ECONNREFUSED")], { route: { type: ROUTE.DIRECT, proxyUrl: null } });
  await direct.client.fetchList(credentials());
  assert.equal(direct.calls.length, 1);
});

test("the activity request counts in-progress tasks of one dot", async () => {
  const { client, calls, events } = fakeClient([
    json(200, { data: [{ status: "in_progress" }, { status: "completed", outcome: "succeeded" }], next_cursor: null }),
    json(200, { nope: true }),
  ]);
  assert.deepEqual(await client.fetchActivity(credentials(), TBO_ID), { ok: true, inProgress: 1 });
  assert.equal(calls[0].url, activityUrl(TBO_ID));
  assert.deepEqual(events[0], { kind: "activity", route: ROUTE.SYSTEM, status: 200, category: null });
  assert.equal((await client.fetchActivity(credentials(), TBO_ID)).category, "badResponse");
});

test("no request is sent without a sign-in or for a malformed dot id", async () => {
  const { client, calls } = fakeClient([]);
  assert.deepEqual(await client.fetchList({ ok: false, reason: "missing" }), { ok: false, category: "signedOut", status: null, retryAfterMs: null });
  assert.equal((await client.fetchActivity(credentials(), "..")).category, "badResponse");
  assert.equal(calls.length, 0);
});

test("nothing the client reports contains the token, account id, dot id or dot name", async () => {
  const outputs = [];
  const answers = [
    json(200, listBody()),
    json(401, { detail: `token ${FAKE_TOKEN}` }),
    requestError("ERR_PROXY_TUNNEL"),
    requestError("ECONNREFUSED"),
    json(429, {}, { retryAfter: "5" }),
    json(200, { data: [{ status: "in_progress", title: DOT_NAME }] }),
  ];
  const { client, events } = fakeClient(answers);
  outputs.push(await client.fetchList(credentials()));
  outputs.push(await client.fetchList(credentials()));
  outputs.push(await client.fetchList(credentials()));
  outputs.push(await client.fetchActivity(credentials(), TBO_ID));
  outputs.push(await client.fetchActivity(credentials(), TBO_ID));
  try {
    assertAllowedRequest("POST", activityUrl(TBO_ID));
  } catch (error) {
    outputs.push(error.message);
  }

  const reported = JSON.stringify([events, outputs.slice(1)]);
  for (const secret of SECRETS) assert.ok(!reported.includes(secret), `leaked ${secret.slice(0, 6)}`);
  assert.ok(!JSON.stringify(outputs[0]).includes(FAKE_TOKEN));
});
