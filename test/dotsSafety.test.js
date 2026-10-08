"use strict";

// Static guards for the ChatGPT Dots code: it may only read. No state-changing HTTP method or backend path (pause,
// resume, reboot, messages, read receipts, ...), no token refresh, no other transport than the one GET helper, no
// file writes. The scan covers code and comments alike, so even a comment cannot name a forbidden call.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const DOTS_SOURCES = [
  "src/net/systemProxy.js",
  "src/net/httpsGetJson.js",
  "src/collectors/chatgptDots.js",
  "src/collectors/dotsAuth.js",
  "src/collectors/dotsNormalize.js",
  "src/collectors/dotsLocalCache.js",
  "src/collectors/dotsPoller.js",
  "src/dashboard/dotsAction.js",
  "src/dashboard/dotsKey.js",
  "src/dashboard/dotsRender.js",
  "src/dashboard/dotsView.js",
];

const FORBIDDEN = [
  [/\b(?:POST|PUT|PATCH|DELETE)\b/, "a state-changing HTTP method"],
  [/method\s*:\s*["'`](?!GET["'`])/i, "a method other than GET"],
  [/\/(?:pause|resume|reboot|messages|read|runtime|elicitation|voice|computers)\b/i, "a state-changing backend path"],
  [/\/messaging\//, "the messaging API"],
  [/\/tbo\/primary\b/, "an endpoint outside the allowlist"],
  [/refresh_token|oauth\/token|grant_type/, "a token refresh"],
  [/\bfetch\s*\(/, "the global fetch (no proxy, no allowlist)"],
  [/\b(?:http|net|tls)\.(?:request|get|connect)\s*\(/, "another transport"],
  [/\b(?:writeFile|appendFile|rename|unlink|rm|mkdir)(?:Sync)?\s*\(/, "a file write"],
  [/codex:\/\/dots[/?]/, "a deep link the app ignores"],
];

function findings(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    for (const [pattern, reason] of FORBIDDEN) {
      if (pattern.test(line)) found.push(`${index + 1}: ${reason}`);
    }
  });
  return found;
}

test("the scanner flags what it is meant to", () => {
  assert.deepEqual(findings("request(url, { method: \"POST\" })").length, 2);
  assert.ok(findings("const url = `${BASE}/tbo/${id}/runtime/pause`;").length > 0);
  assert.ok(findings("await fetch(url)").length > 0);
  assert.ok(findings("body: { grant_type: 'refresh_token' }").length > 0);
  assert.ok(findings("fs.writeFileSync(file, text)").length > 0);
  assert.ok(findings("open('codex://dots/')").length > 0);
  assert.deepEqual(findings("request(url, { method: \"GET\", headers, agent })"), []);
});

test("the Dots sources only ever read", () => {
  for (const file of DOTS_SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.deepEqual(findings(text), [], file);
  }
});

test("only the GET helper sends requests, and only the Dots client uses it", () => {
  for (const file of DOTS_SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const sends = /\bhttps\.request\b/.test(text);
    assert.equal(sends, file === "src/net/httpsGetJson.js", `${file} calls https.request`);
    const usesHelper = /require\("\.\.\/net\/httpsGetJson"\)/.test(text);
    assert.equal(usesHelper, file === "src/collectors/chatgptDots.js", `${file} loads the GET helper`);
  }
  // The client checks every URL against the allowlist right before sending it.
  const client = fs.readFileSync(path.join(ROOT, "src/collectors/chatgptDots.js"), "utf8");
  assert.match(client, /assertAllowedRequest\("GET", url\);\s*\n\s*const params/);
});

test("the token only leaves auth.json for the request header", () => {
  for (const file of DOTS_SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const uses = (text.match(/\.accessToken\b/g) || []).length;
    if (file === "src/collectors/chatgptDots.js") assert.equal(uses, 1, "Authorization header only");
    else if (file !== "src/collectors/dotsAuth.js") assert.equal(uses, 0, file);
  }
});

test("src/plugin.js only dispatches to the Dots controller", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "plugin.js"), "utf8");
  assert.doesNotMatch(source, /openChatGptDots|createDotsPoller|createDotsClient|readDotsCredentials/);
  assert.match(source, /item\.type !== "newSession" && item\.type !== "dots"/, "a Dots key does not start the Codex snapshot loop");
  assert.equal((source.match(/dotsKey\.\w+\(/g) || []).length <= 12, true);
});
