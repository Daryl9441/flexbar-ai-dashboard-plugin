"use strict";

// One HTTPS GET with a deadline and a size cap. It only ever sends GET (callers cannot pick the method), settles
// exactly once (Node's ClientRequest can emit "error" twice for a refused proxy tunnel), and its errors carry only a
// code: built-in messages can name the proxy URL, credentials included.

const https = require("node:https");
const zlib = require("node:zlib");

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

class RequestError extends Error {
  constructor(code, beforeResponse) {
    super(`HTTPS request failed (${code})`);
    this.name = "RequestError";
    this.code = code;
    // True when it failed before any response arrived (connect, proxy tunnel, TLS or a silent server).
    this.beforeResponse = beforeResponse;
  }
}

/**
 * Resolves with { status, contentType, isJson, json, retryAfter, cfMitigated } for any HTTP status; rejects with a
 * RequestError ({ code, beforeResponse }) when there is no complete answer.
 */
function httpsGetJson(options) {
  const {
    url,
    headers = {},
    agent,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    request = https.request,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let responded = false;
    let req = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => {
      if (settled) return;
      finish(reject, toRequestError(error, !responded));
      destroyQuietly(req);
    };
    const timer = setTimeout(() => fail({ code: "ETIMEDOUT" }), timeoutMs);

    try {
      req = request(url, { method: "GET", headers, agent }, (res) => {
        responded = true;
        readBody(res, maxBytes).then((text) => finish(resolve, describeResponse(res, text)), fail);
      });
    } catch (error) {
      fail(error);
      return;
    }
    req.on("error", fail);
    req.end();
  });
}

function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const stream = decodedStream(res);
    const chunks = [];
    let total = 0;
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject({ code: "ERESPONSETOOLARGE" });
        destroyQuietly(res);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
    if (stream !== res) res.on("error", reject);
  });
}

function decodedStream(res) {
  const encoding = String(res.headers["content-encoding"] || "").trim().toLowerCase();
  let decoder = null;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = zlib.createGunzip();
  else if (encoding === "deflate") decoder = zlib.createInflate();
  else if (encoding === "br") decoder = zlib.createBrotliDecompress();
  return decoder ? res.pipe(decoder) : res;
}

function describeResponse(res, text) {
  const contentType = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  let json = null;
  let isJson = false;
  if (/\bjson\b/.test(contentType)) {
    try {
      json = JSON.parse(text);
      isJson = true;
    } catch {
      json = null;
    }
  }
  return {
    status: res.statusCode,
    contentType,
    isJson,
    json,
    retryAfter: headerValue(res.headers["retry-after"]),
    cfMitigated: headerValue(res.headers["cf-mitigated"]),
  };
}

function headerValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  return value === undefined || value === null ? null : String(value);
}

function toRequestError(error, beforeResponse) {
  const code = error && typeof error.code === "string" && error.code ? error.code : "EREQUEST";
  return new RequestError(code, beforeResponse);
}

function destroyQuietly(stream) {
  try {
    if (stream && typeof stream.destroy === "function") stream.destroy();
  } catch {
    // Already torn down.
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  RequestError,
  httpsGetJson,
};
