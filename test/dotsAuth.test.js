"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decodeJwtPayload,
  isTokenExpired,
  readDotsCredentials,
} = require("../src/collectors/dotsAuth");

// Fake credentials, assembled at runtime so the source holds nothing token-shaped.
const FAKE_ACCOUNT = "acct-" + "0".repeat(8);
const CLAIM = "https://api.openai.com/auth";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [encode({ alg: "none", typ: "JWT" }), encode(payload), "c".repeat(20)].join(".");
}

function codexHome(t, auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-dots-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (auth !== undefined) {
    fs.writeFileSync(path.join(dir, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth));
  }
  return dir;
}

test("a ChatGPT sign-in yields the token, account id and expiry", (t) => {
  const token = fakeJwt({ exp: NOW / 1000 + 3_600, [CLAIM]: { chatgpt_account_id: "other" } });
  const home = codexHome(t, { auth_mode: "chatgpt", tokens: { access_token: token, account_id: FAKE_ACCOUNT, refresh_token: "r".repeat(30) } });

  const credentials = readDotsCredentials(home);
  assert.equal(credentials.ok, true);
  assert.equal(credentials.accessToken, token);
  assert.equal(credentials.accountId, FAKE_ACCOUNT, "tokens.account_id wins over the JWT claim");
  assert.equal(credentials.expiresAt, NOW + 3_600_000);
  assert.equal(isTokenExpired(credentials, NOW), false);
});

test("the token and account id never show up when the credentials are printed", (t) => {
  const token = fakeJwt({ exp: NOW / 1000 + 3_600 });
  const home = codexHome(t, { tokens: { access_token: token, account_id: FAKE_ACCOUNT } });
  const credentials = readDotsCredentials(home);

  for (const text of [JSON.stringify(credentials), util.inspect(credentials), String(Object.keys(credentials))]) {
    assert.ok(!text.includes(token), text);
    assert.ok(!text.includes(FAKE_ACCOUNT), text);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(credentials)), { ok: true, expiresAt: NOW + 3_600_000, hasAccountId: true });
});

test("the account id falls back to the JWT claim", (t) => {
  const token = fakeJwt({ exp: NOW / 1000 + 60, [CLAIM]: { chatgpt_account_id: FAKE_ACCOUNT } });
  const credentials = readDotsCredentials(codexHome(t, { tokens: { access_token: token } }));
  assert.equal(credentials.ok, true);
  assert.equal(credentials.accountId, FAKE_ACCOUNT);

  const opaque = readDotsCredentials(codexHome(t, { tokens: { access_token: "opaque-" + "t".repeat(24) } }));
  assert.equal(opaque.ok, true);
  assert.equal(opaque.accountId, null);
  assert.equal(opaque.expiresAt, null);
  assert.equal(isTokenExpired(opaque, NOW), false, "an unknown expiry is left to the server");
});

test("missing or unusable sign-ins give a reason and no detail", (t) => {
  assert.deepEqual(plain(readDotsCredentials("")), { ok: false, reason: "missing" });
  assert.deepEqual(plain(readDotsCredentials(codexHome(t))), { ok: false, reason: "missing" });
  assert.deepEqual(plain(readDotsCredentials(codexHome(t, "{\"tokens\": "))), { ok: false, reason: "unreadable" });
  assert.deepEqual(plain(readDotsCredentials(codexHome(t, "[1, 2]"))), { ok: false, reason: "unreadable" });
  assert.deepEqual(plain(readDotsCredentials(codexHome(t, { auth_mode: "apikey", OPENAI_API_KEY: "k".repeat(20) }))), { ok: false, reason: "notChatgpt" });
  assert.deepEqual(plain(readDotsCredentials(codexHome(t, { auth_mode: "chatgpt" }))), { ok: false, reason: "noToken" });
  assert.deepEqual(plain(readDotsCredentials(codexHome(t, { tokens: { access_token: "" } }))), { ok: false, reason: "noToken" });
});

test("a read error other than a missing file counts as unreadable (the app may be rewriting it)", () => {
  const fakeFs = {
    readFileSync() {
      throw Object.assign(new Error("EACCES: permission denied, open '/Users/me/.codex/auth.json'"), { code: "EACCES" });
    },
  };
  assert.deepEqual(plain(readDotsCredentials("/Users/me/.codex", { fs: fakeFs })), { ok: false, reason: "unreadable" });
});

test("decodeJwtPayload only base64-decodes and never throws", () => {
  assert.deepEqual(decodeJwtPayload(fakeJwt({ exp: 1, sub: "x" })), { exp: 1, sub: "x" });
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
  assert.equal(decodeJwtPayload("a.%%%.c"), null);
  assert.equal(decodeJwtPayload(`a.${Buffer.from("[1]").toString("base64url")}.c`), null);
  assert.equal(decodeJwtPayload(null), null);
});

test("isTokenExpired allows a minute of clock skew", (t) => {
  const soon = readDotsCredentials(codexHome(t, { tokens: { access_token: fakeJwt({ exp: NOW / 1000 + 30 }) } }));
  const past = readDotsCredentials(codexHome(t, { tokens: { access_token: fakeJwt({ exp: NOW / 1000 - 10 }) } }));
  assert.equal(isTokenExpired(soon, NOW), true, "expires within the skew");
  assert.equal(isTokenExpired(soon, NOW, 0), false);
  assert.equal(isTokenExpired(past, NOW, 0), true);
  assert.equal(isTokenExpired({ ok: false, reason: "missing" }, NOW), false);
});

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
