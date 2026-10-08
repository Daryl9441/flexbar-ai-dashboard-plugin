"use strict";

// Reads the ChatGPT sign-in that the ChatGPT app and the Codex CLI share ($CODEX_HOME/auth.json) for the Dots
// status requests. Read-only: the plugin never refreshes the token (the refresh token rotates, so a refresh here
// could sign the app or the CLI out); once the access token expires the key falls back to the app's local cache
// until the app refreshes it. The token and account id are non-enumerable, so printing or serializing the result
// never shows them, and failures carry a reason code only (a JSON.parse message would quote the file).

const nodeFs = require("node:fs");
const path = require("node:path");

const AUTH_FILE = "auth.json";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const DEFAULT_EXPIRY_SKEW_MS = 60_000;

/**
 * { ok: true, expiresAt, hasAccountId } plus the hidden accessToken / accountId, or
 * { ok: false, reason: "missing" | "unreadable" | "notChatgpt" | "noToken" }.
 */
function readDotsCredentials(codexHome, options = {}) {
  const fs = options.fs || nodeFs;
  if (!codexHome) return failure("missing");

  let text;
  try {
    text = fs.readFileSync(path.join(codexHome, AUTH_FILE), "utf8");
  } catch (error) {
    return failure(error && error.code === "ENOENT" ? "missing" : "unreadable");
  }

  let auth;
  try {
    auth = JSON.parse(text);
  } catch {
    return failure("unreadable");
  }
  if (!isObject(auth)) return failure("unreadable");
  if (typeof auth.auth_mode === "string" && auth.auth_mode.trim().toLowerCase() !== "chatgpt") {
    return failure("notChatgpt");
  }

  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  const accessToken = nonEmptyString(tokens.access_token) || nonEmptyString(tokens.accessToken);
  if (!accessToken) return failure("noToken");

  const claims = decodeJwtPayload(accessToken);
  const accountId = nonEmptyString(tokens.account_id) || nonEmptyString(tokens.accountId) || claimAccountId(claims);
  const expiresAt = claims && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  return success(accessToken, accountId, expiresAt);
}

/** The JWT payload, base64url-decoded only (never verified), or null. */
function decodeJwtPayload(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** True when the token's exp has passed (or is within `skewMs`); false when unknown. */
function isTokenExpired(credentials, now = Date.now(), skewMs = DEFAULT_EXPIRY_SKEW_MS) {
  if (!credentials || !credentials.ok || !Number.isFinite(credentials.expiresAt)) return false;
  return credentials.expiresAt - skewMs <= now;
}

function claimAccountId(claims) {
  const auth = claims && isObject(claims[ACCOUNT_CLAIM]) ? claims[ACCOUNT_CLAIM] : null;
  return auth ? nonEmptyString(auth.chatgpt_account_id) : null;
}

function success(accessToken, accountId, expiresAt) {
  const credentials = { ok: true, expiresAt, hasAccountId: Boolean(accountId) };
  Object.defineProperties(credentials, {
    accessToken: { value: accessToken, enumerable: false },
    accountId: { value: accountId || null, enumerable: false },
  });
  return Object.freeze(credentials);
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  decodeJwtPayload,
  isTokenExpired,
  readDotsCredentials,
};
