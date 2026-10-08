"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const zlib = require("node:zlib");
const { EventEmitter } = require("node:events");

const { httpsGetJson } = require("../src/net/httpsGetJson");
const { ROUTE, createRouteAgent, supportsProxyEnv } = require("../src/net/systemProxy");

// A local plain-HTTP server stands in for chatgpt.com: httpsGetJson takes the request function, so the tests pass
// http.request and never leave the machine.
function startServer(t, handler) {
  const server = http.createServer(handler);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("a JSON answer is parsed and its retry and Cloudflare headers are surfaced", async (t) => {
  const seen = [];
  const base = await startServer(t, (req, res) => {
    seen.push({ method: req.method, accept: req.headers.accept });
    res.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": "120", "cf-mitigated": "challenge" });
    res.end(JSON.stringify({ detail: "slow down" }));
  });

  const answer = await httpsGetJson({ url: `${base}/backend-api/tbo`, headers: { Accept: "application/json" }, request: http.request });
  assert.deepEqual(answer, {
    status: 429,
    contentType: "application/json",
    isJson: true,
    json: { detail: "slow down" },
    retryAfter: "120",
    cfMitigated: "challenge",
  });
  assert.deepEqual(seen, [{ method: "GET", accept: "application/json" }]);
});

test("an HTML or broken JSON body is reported as not JSON", async (t) => {
  const base = await startServer(t, (req, res) => {
    if (req.url === "/html") {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html>Just a moment...</html>");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{not json");
  });

  const html = await httpsGetJson({ url: `${base}/html`, request: http.request });
  assert.equal(html.status, 403);
  assert.equal(html.isJson, false);
  assert.equal(html.json, null);
  assert.equal(html.contentType, "text/html");
  assert.equal(html.retryAfter, null);
  assert.equal(html.cfMitigated, null);

  const broken = await httpsGetJson({ url: `${base}/broken`, request: http.request });
  assert.equal(broken.isJson, false);
  assert.equal(broken.json, null);
});

test("gzip and brotli bodies are decompressed", async (t) => {
  const body = JSON.stringify({ items: [{ id: "x" }] });
  const base = await startServer(t, (req, res) => {
    const encoding = req.url === "/br" ? "br" : "gzip";
    const data = encoding === "br" ? zlib.brotliCompressSync(body) : zlib.gzipSync(body);
    res.writeHead(200, { "content-type": "application/json", "content-encoding": encoding });
    res.end(data);
  });

  assert.deepEqual((await httpsGetJson({ url: `${base}/gz`, request: http.request })).json, { items: [{ id: "x" }] });
  assert.deepEqual((await httpsGetJson({ url: `${base}/br`, request: http.request })).json, { items: [{ id: "x" }] });
});

test("a body over the size limit is refused", async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pad: "x".repeat(4_096) }));
  });

  await assert.rejects(
    httpsGetJson({ url: base, maxBytes: 1_024, request: http.request }),
    (error) => error.code === "ERESPONSETOOLARGE" && error.beforeResponse === false
  );
});

test("a silent server times out before any response", async (t) => {
  const base = await startServer(t, () => {
    // Never answers.
  });
  const started = Date.now();
  await assert.rejects(
    httpsGetJson({ url: base, timeoutMs: 150, request: http.request }),
    (error) => error.code === "ETIMEDOUT" && error.beforeResponse === true
  );
  assert.ok(Date.now() - started < 2_000);
});

test("a refused connection is a failure before the response, with no address in the message", async () => {
  const port = await closedPort();
  await assert.rejects(
    httpsGetJson({ url: `http://127.0.0.1:${port}/`, request: http.request }),
    (error) => {
      assert.equal(error.code, "ECONNREFUSED");
      assert.equal(error.beforeResponse, true);
      assert.doesNotMatch(error.message, /127\.0\.0\.1|:\d{2,5}/);
      return true;
    }
  );
});

test("a request whose error is emitted twice settles once", async () => {
  let calls = 0;
  const request = (url, options) => {
    calls += 1;
    assert.equal(options.method, "GET");
    const req = new EventEmitter();
    req.end = () => {
      setImmediate(() => {
        const error = Object.assign(new Error("Failed to establish tunnel via http://user:pass@proxy.example:1"), { code: "ERR_PROXY_TUNNEL" });
        req.emit("error", error);
        req.emit("error", error);
      });
    };
    req.destroy = () => {};
    return req;
  };

  let rejections = 0;
  await httpsGetJson({ url: "https://chatgpt.com/backend-api/tbo", request }).catch((error) => {
    rejections += 1;
    assert.equal(error.code, "ERR_PROXY_TUNNEL");
    assert.equal(error.beforeResponse, true);
    assert.doesNotMatch(error.message, /user|pass|proxy\.example/, "proxy credentials never reach the message");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rejections, 1);
  assert.equal(calls, 1);
});

test("a request function that throws is turned into a rejection", async () => {
  await assert.rejects(
    httpsGetJson({
      url: "https://chatgpt.com/backend-api/tbo",
      request: () => {
        throw Object.assign(new Error("bad options"), { code: "ERR_INVALID_ARG_TYPE" });
      },
    }),
    (error) => error.code === "ERR_INVALID_ARG_TYPE" && error.beforeResponse === true
  );
});

test("the built-in proxy agent tunnels through CONNECT and a refused tunnel rejects once", { skip: !supportsProxyEnv() }, async (t) => {
  const seen = [];
  const proxy = net.createServer((client) => {
    client.once("data", (chunk) => {
      seen.push(chunk.toString("latin1").split("\r\n")[0]);
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
  });
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

  const agent = createRouteAgent({ type: ROUTE.SYSTEM, proxyUrl: `http://127.0.0.1:${proxy.address().port}` });
  let rejections = 0;
  await httpsGetJson({ url: "https://chatgpt.invalid/backend-api/tbo", agent, request: https.request }).catch((error) => {
    rejections += 1;
    assert.equal(error.code, "ERR_PROXY_TUNNEL");
    assert.equal(error.beforeResponse, true);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(rejections, 1);
  assert.deepEqual(seen, ["CONNECT chatgpt.invalid:443 HTTP/1.1"]);
});
