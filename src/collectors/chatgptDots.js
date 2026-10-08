"use strict";

// Read-only client for the ChatGPT Dots status (internal name "tbo"): the dot list with its room previews and one
// dot's recent activity. Two GET endpoints on chatgpt.com, checked against a fixed allowlist before every request;
// nothing else of the backend is ever called. Results carry error categories, never response bodies or headers.

const { httpsGetJson, DEFAULT_MAX_BYTES } = require("../net/httpsGetJson");
const { ROUTE, createProxyResolver, createRouteAgent } = require("../net/systemProxy");
const { isTokenExpired } = require("./dotsAuth");
const { countInProgress, normalizeDotsList } = require("./dotsNormalize");

const DOTS_HOST = "chatgpt.com";
const BACKEND_BASE = `https://${DOTS_HOST}/backend-api`;
const DOTS_LIST_URL = `${BACKEND_BASE}/tbo?limit=25&include_room_preview=true`;
const ACTIVITY_LIMIT = 5;
const ALLOWED_PATHS = Object.freeze([/^\/backend-api\/tbo$/, /^\/backend-api\/tbo\/[^/]+\/activity$/]);
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = "codex-cli";
const FALLBACK_ROUTE = "direct-fallback";
// Failures that mean the proxy could not be reached or refused the tunnel: a GET may then go direct, once.
// ECONNRESET is not one of them: Node reports it as well for a tunnel the proxy accepted and dropped later.
const PROXY_FAILURE_CODES = new Set(["ERR_PROXY_TUNNEL", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

class DisallowedRequestError extends Error {
  constructor(reason) {
    super(`Dots request not allowed (${reason})`);
    this.name = "DisallowedRequestError";
  }
}

/** Throws unless this is a GET of the dot list or of one dot's activity on https://chatgpt.com. */
function assertAllowedRequest(method, rawUrl) {
  if (String(method || "").toUpperCase() !== "GET") throw new DisallowedRequestError("method");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DisallowedRequestError("url");
  }
  if (url.protocol !== "https:" || url.hostname !== DOTS_HOST || url.port !== "") throw new DisallowedRequestError("host");
  if (url.username || url.password) throw new DisallowedRequestError("credentials");
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(url.pathname))) throw new DisallowedRequestError("path");
}

/** The activity URL of one dot. The id is percent-encoded; "~" (unreserved) stays as the app sends it. */
function activityUrl(tboId) {
  const encoded = typeof tboId === "string" ? encodeURIComponent(tboId.trim()) : "";
  if (!encoded || encoded === "." || encoded === "..") throw new DisallowedRequestError("id");
  return `${BACKEND_BASE}/tbo/${encoded}/activity?limit=${ACTIVITY_LIMIT}`;
}

// The same headers as the plan-usage query (no desktop-app headers: the backend answers this without them).
function buildDotsHeaders(credentials) {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    ...(credentials.accountId ? { "ChatGPT-Account-Id": credentials.accountId } : {}),
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

/**
 * HTTP answer -> { ok: true } or { ok: false, category, status, retryAfterMs }. Categories: blocked (a non-JSON
 * answer such as a Cloudflare challenge), authExpired / authRejected (401 after / before the token's exp),
 * noAccess (a JSON 403/404: no Dots on this account), rateLimited (429), server (5xx), badResponse (anything else).
 */
function classifyResponse(response, { tokenExpired = false, now = Date.now() } = {}) {
  const { status } = response;
  const challenged = Boolean(response.cfMitigated) || !response.isJson;
  const failed = (category, retryAfterMs = null) => ({ ok: false, category, status, retryAfterMs });
  if (status >= 200 && status < 300) return challenged ? failed("blocked") : { ok: true };
  if (status === 401) return failed(tokenExpired ? "authExpired" : "authRejected");
  if (status === 403 || status === 404) return failed(challenged ? "blocked" : "noAccess");
  if (status === 429) return failed("rateLimited", parseRetryAfter(response.retryAfter, now));
  if (status >= 500) return failed("server");
  return failed("badResponse");
}

/** Retry-After in ms (delta seconds or an HTTP date), or null. */
function parseRetryAfter(value, now = Date.now()) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (/^-/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * fetchList(credentials) -> { ok: true, dots } | failure; fetchActivity(credentials, tboId) -> { ok: true,
 * inProgress } | failure. A failure is { ok: false, category, status, retryAfterMs }; "network" for no answer.
 * onRequest receives { kind, route, status, category } per attempt (no URL, id or header).
 */
function createDotsClient(options = {}) {
  const resolver = options.resolveRoute ? null : createProxyResolver();
  const context = {
    resolveRoute: options.resolveRoute || ((host) => resolver.resolve(host)),
    getJson: options.getJson || httpsGetJson,
    createAgent: options.createAgent || createRouteAgent,
    now: typeof options.now === "function" ? options.now : Date.now,
    onRequest: typeof options.onRequest === "function" ? options.onRequest : () => {},
  };
  return {
    fetchList: (credentials) => fetchList(context, credentials),
    fetchActivity: (credentials, tboId) => fetchActivity(context, credentials, tboId),
  };
}

async function fetchList(context, credentials) {
  const answer = await sendGet(context, "list", DOTS_LIST_URL, credentials);
  if (!answer.ok) return answer;
  const dots = normalizeDotsList(answer.json);
  return dots ? { ok: true, dots } : failure("badResponse", 200);
}

async function fetchActivity(context, credentials, tboId) {
  let url;
  try {
    url = activityUrl(tboId);
  } catch {
    return failure("badResponse");
  }
  const answer = await sendGet(context, "activity", url, credentials);
  if (!answer.ok) return answer;
  const inProgress = countInProgress(answer.json);
  return inProgress === null ? failure("badResponse", 200) : { ok: true, inProgress };
}

// One allowlisted GET: through the route's proxy, and once more directly when that proxy could not be reached.
async function sendGet(context, kind, url, credentials) {
  if (!credentials || !credentials.ok) return failure("signedOut");
  assertAllowedRequest("GET", url);
  const params = { url, headers: buildDotsHeaders(credentials), timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: DEFAULT_MAX_BYTES };
  const route = await context.resolveRoute(DOTS_HOST);
  try {
    return await attempt(context, kind, route.type, { ...params, agent: context.createAgent(route) }, credentials);
  } catch (error) {
    if (!route.proxyUrl || !error || !error.beforeResponse || !PROXY_FAILURE_CODES.has(error.code)) {
      return failure("network");
    }
  }
  try {
    const direct = { ...params, agent: context.createAgent({ type: ROUTE.DIRECT, proxyUrl: null }) };
    return await attempt(context, kind, FALLBACK_ROUTE, direct, credentials);
  } catch {
    return failure("network");
  }
}

async function attempt(context, kind, routeType, params, credentials) {
  let response;
  try {
    response = await context.getJson(params);
  } catch (error) {
    context.onRequest({ kind, route: routeType, status: null, category: "network" });
    throw error;
  }
  const now = context.now();
  const verdict = classifyResponse(response, { tokenExpired: isTokenExpired(credentials, now, 0), now });
  context.onRequest({ kind, route: routeType, status: response.status, category: verdict.ok ? null : verdict.category });
  return verdict.ok ? { ok: true, json: response.json } : verdict;
}

function failure(category, status = null) {
  return { ok: false, category, status, retryAfterMs: null };
}

module.exports = {
  DOTS_HOST,
  DOTS_LIST_URL,
  activityUrl,
  assertAllowedRequest,
  buildDotsHeaders,
  classifyResponse,
  createDotsClient,
  parseRetryAfter,
};
