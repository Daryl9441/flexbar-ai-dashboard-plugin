"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const canvasModule = require("@napi-rs/canvas");
const {
  ICON_BADGES,
  ICON_SPECS,
  OPENAI_LOGO_PATH,
  drawOpenAiLogo,
  renderOpenAiIcon,
} = require("../src/dashboard/openaiLogo");
const { iconTargets, jsonValueSpans } = require("../scripts/generate-icons.cjs");
const { scanText } = require("../scripts/check-privacy.cjs");

const ROOT = path.resolve(__dirname, "..");
const GENERATOR = path.join(ROOT, "scripts", "generate-icons.cjs");
const MANIFEST = path.join(ROOT, "com.aspen.flexbar-ai-dashboard.plugin", "manifest.json");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UUID = "com.aspen.flexbar-ai-dashboard";

test("the OpenAI logo path draws inside its box only, with a hollow center", () => {
  assert.match(OPENAI_LOGO_PATH, /^M22\.2819 9\.8211a5\.9847 .*-1\.4997Z$/);

  const canvas = canvasModule.createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#123456";

  assert.equal(drawOpenAiLogo(ctx, 16, 16, 32, "#ffffff", canvasModule), true);

  const { data } = ctx.getImageData(0, 0, 64, 64);
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const offset = (y * 64 + x) * 4;
      if (data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 0) continue;
      if (x >= 16 && x < 48 && y >= 16 && y < 48) inside += 1;
      else outside += 1;
    }
  }
  assert.equal(outside, 0);
  assert.ok(inside > 32 * 32 * 0.3 && inside < 32 * 32 * 0.8, `logo covers ${inside} of 1024 box pixels`);
  // The hexagon in the middle of the mark is an opening.
  assert.deepEqual(pixel(data, 64, 32, 32), [0, 0, 0, 255]);

  // The caller's transform and fill style are restored.
  assert.equal(ctx.getTransform().isIdentity, true);
  ctx.fillRect(0, 0, 1, 1);
  assert.deepEqual(Array.from(ctx.getImageData(0, 0, 1, 1).data), [0x12, 0x34, 0x56, 255]);
});

test("drawOpenAiLogo builds the Path2D once per canvas module and saves/restores the context", () => {
  let constructed = 0;
  class FakePath2D {
    constructor(d) {
      constructed += 1;
      this.d = d;
    }
  }
  const fakeModule = { Path2D: FakePath2D };
  const calls = [];
  const ctx = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    translate: (x, y) => calls.push(`translate ${x} ${y}`),
    scale: (x, y) => calls.push(`scale ${x} ${y}`),
    fill: (p) => calls.push(`fill ${p instanceof FakePath2D && p.d === OPENAI_LOGO_PATH}`),
  };

  assert.equal(drawOpenAiLogo(ctx, 4, 6, 48, "#fff", fakeModule), true);
  assert.equal(drawOpenAiLogo(ctx, 4, 6, 48, "#fff", fakeModule), true);
  assert.equal(constructed, 1);
  assert.deepEqual(calls.slice(0, 5), ["save", "translate 4 6", "scale 2 2", "fill true", "restore"]);
});

test("drawOpenAiLogo draws nothing and returns false without Path2D or on a failing context", () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (_, name) => () => calls.push(String(name)) });

  assert.equal(drawOpenAiLogo(ctx, 0, 0, 24, "#fff", { createCanvas() {} }), false);
  if (typeof globalThis.Path2D !== "function") assert.equal(drawOpenAiLogo(ctx, 0, 0, 24, "#fff", null), false);
  assert.deepEqual(calls, []);

  assert.equal(drawOpenAiLogo(null, 0, 0, 24, "#fff", canvasModule), false);
  assert.equal(drawOpenAiLogo(ctx, 0, 0, 0, "#fff", canvasModule), false);
  assert.equal(drawOpenAiLogo(ctx, Number.NaN, 0, 24, "#fff", canvasModule), false);

  const throwing = {
    save() {},
    restore() {
      calls.push("restore");
    },
    translate() {},
    scale() {},
    fill() {
      throw new Error("boom");
    },
  };
  assert.equal(drawOpenAiLogo(throwing, 0, 0, 24, "#fff", canvasModule), false);
  assert.deepEqual(calls, ["restore"]);
});

test("renderOpenAiIcon returns PNG data URIs of the requested size, with and without each badge", async () => {
  const badges = [null, ...Object.keys(ICON_BADGES)];
  for (const size of [96, 48]) {
    const seen = new Set();
    for (const badge of badges) {
      const uri = renderOpenAiIcon({ size, badge, canvasModule });
      assert.match(uri, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
      const png = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
      assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
      assert.equal(png.toString("latin1", 12, 16), "IHDR");
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `${badge} at ${size}px`);
      seen.add(uri);

      const image = await canvasModule.loadImage(png);
      const canvas = canvasModule.createCanvas(size, size);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, size, size);
      // Rounded tile: transparent corner, dark middle edge.
      assert.equal(pixel(data, size, 0, 0)[3], 0);
      assert.deepEqual(pixel(data, size, Math.round(size / 2), 1), [0x0d, 0x0d, 0x0d, 255]);
      const white = countColor(data, [255, 255, 255]);
      assert.ok(white > size * size * 0.05, `${badge} at ${size}px shows the logo (${white} white pixels)`);
      if (badge) {
        const color = hexToRgb(ICON_BADGES[badge].color);
        assert.ok(countColor(data, color) > size * size * 0.02, `${badge} badge color is visible at ${size}px`);
      }
    }
    assert.equal(seen.size, badges.length, `every icon at ${size}px is distinct`);
  }
});

test("the Dots badge is three dark dots on a color no other key uses", () => {
  const dots = ICON_BADGES.dots;
  assert.equal(dots.glyph, "dots");
  const others = Object.entries(ICON_BADGES).filter(([name]) => name !== "dots").map(([, spec]) => spec.color);
  assert.ok(!others.includes(dots.color));

  const circles = [];
  const ctx = {
    beginPath() {},
    arc(x, y, radius) {
      circles.push({ x, y, radius });
    },
    fill() {},
    set fillStyle(value) {
      this.color = value;
    },
  };
  dots.draw(ctx, 50, 50, 10);
  assert.equal(circles.length, 3);
  assert.ok(circles.every((circle) => circle.y === 50 && circle.radius > 1 && circle.radius < 3));
  assert.deepEqual(circles.map((circle) => Math.round(circle.x - 50)), [-5, 0, 5]);
  assert.equal(ctx.color, "#0d0d0d");
});

test("renderOpenAiIcon rejects unknown badges, bad sizes and a missing canvas", () => {
  assert.throws(() => renderOpenAiIcon({ badge: "nope", canvasModule }), /Unknown icon badge "nope"/);
  assert.throws(() => renderOpenAiIcon({ badge: "toString", canvasModule }), /Unknown icon badge/);
  assert.throws(() => renderOpenAiIcon({ size: 8, canvasModule }), RangeError);
  assert.throws(() => renderOpenAiIcon({ size: 47.5, canvasModule }), RangeError);
  assert.throws(() => renderOpenAiIcon({ canvasModule: null }), /@napi-rs\/canvas is required/);
});

test("ICON_SPECS maps the key library and every key to a known badge, and the manifest has every target", () => {
  assert.deepEqual(ICON_SPECS, {
    keyLibrary: null,
    [`${UUID}.session`]: "session",
    [`${UUID}.token-usage`]: "token",
    [`${UUID}.plan-usage`]: "plan",
    [`${UUID}.reset-timer`]: "reset",
    [`${UUID}.new-session`]: "newSession",
    [`${UUID}.skill`]: "skill",
    [`${UUID}.dots`]: "dots",
  });
  for (const [name, spec] of Object.entries(ICON_BADGES)) {
    assert.match(spec.color, /^#[0-9a-f]{6}$/, name);
    assert.equal(typeof spec.draw, "function", name);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  assert.deepEqual(iconTargets(manifest).map((entry) => entry.target), Object.keys(ICON_SPECS));
  for (const child of manifest.keyLibrary.children) {
    assert.ok(Object.prototype.hasOwnProperty.call(ICON_SPECS, child.cid), `icon spec for ${child.cid}`);
  }
});

test("manifest.json: the plugin and every key use the OpenAI icons, 96x96 PNG data URIs", async () => {
  const text = fs.readFileSync(MANIFEST, "utf8");
  const manifest = JSON.parse(text);
  const targets = iconTargets(manifest);
  assert.equal(targets.length, 8);
  for (const { target, badge, jsonPath } of targets) {
    const uri = jsonPath.reduce((node, part) => node[part], manifest);
    assert.doesNotMatch(uri, /^mdi\b/, target);
    assert.match(uri, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, target);
    const png = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE, target);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96], target);

    // The dark tile with the white mark, plus the key's badge color.
    const data = await decodePixels(png);
    assert.deepEqual(pixel(data, 96, 48, 1), [0x0d, 0x0d, 0x0d, 255], target);
    assert.ok(countColor(data, [255, 255, 255]) > 96 * 96 * 0.05, `${target}: white mark`);
    if (badge) assert.ok(countColor(data, hexToRgb(ICON_BADGES[badge].color)) > 96 * 96 * 0.02, `${target}: ${badge} badge`);
    // And what openaiLogo.js draws now: after changing it, `npm run icons` keeps this passing.
    const current = await decodePixels(renderOpenAiIcon({ size: 96, badge, canvasModule }));
    assert.ok(maxChannelDifference(data, current) <= 8, `${target}: the icon is current (run npm run icons)`);
  }
  // No key-library icon is an mdi class any more (key data never holds an icon).
  assert.doesNotMatch(text, /"icon":\s*"mdi /);
  assert.deepEqual(scanText(text, { path: "manifest.json" }), [], "the base64 icons pass the privacy scan");
});

test("jsonValueSpans locates values by path in the raw text", () => {
  const text = '{ "a": [1, {"b": "x\\"y"}], "c": {"d": null}, "a2": -1.5e3 }';
  const spans = jsonValueSpans(text);
  const slice = (jsonPath) => {
    const span = spans.get(JSON.stringify(jsonPath));
    return text.slice(span.start, span.end);
  };
  assert.equal(slice(["a", 1, "b"]), '"x\\"y"');
  assert.equal(slice(["c", "d"]), "null");
  assert.equal(slice(["a2"]), "-1.5e3");
  assert.equal(slice(["a"]), '[1, {"b": "x\\"y"}]');
  assert.throws(() => jsonValueSpans('{"a": 1} x'), SyntaxError);
});

test("generate-icons --write replaces exactly the eight icon values and keeps every other byte", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-icons-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "manifest.json");
  const before = fixtureManifest();
  fs.writeFileSync(file, before);

  const dryRun = runGenerator(["--manifest", file]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /would update/);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  const write = runGenerator(["--write", "--manifest", file]);
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /wrote 8 icon\(s\)/);
  assert.match(write.stdout, /no icon spec for "com\.example\.other"/);
  const after = fs.readFileSync(file, "utf8");

  // Parsed: only the eight icon fields differ, each now a 96x96 PNG data URI.
  const oldJson = JSON.parse(before);
  const newJson = JSON.parse(after);
  const iconPaths = iconTargets(oldJson).map((entry) => entry.jsonPath);
  assert.equal(iconPaths.length, 8);
  for (const jsonPath of iconPaths) {
    const uri = getPath(newJson, jsonPath);
    assert.match(uri, /^data:image\/png;base64,/);
    const png = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96]);
    setPath(oldJson, jsonPath, null);
    setPath(newJson, jsonPath, null);
  }
  assert.deepEqual(newJson, oldJson);

  // Raw text: same lines, and the changed ones differ only inside the icon string.
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  assert.equal(newLines.length, oldLines.length);
  const changed = oldLines.flatMap((line, index) => (line === newLines[index] ? [] : [index]));
  assert.equal(changed.length, 8);
  for (const index of changed) {
    const [, prefix, suffix] = /^(\s*"icon": )"[^"]*"(,?)$/.exec(oldLines[index]);
    assert.ok(newLines[index].startsWith(`${prefix}"data:image/png;base64,`), newLines[index].slice(0, 60));
    assert.ok(newLines[index].endsWith(`"${suffix}`));
  }
  assert.ok(after.includes('"icon": "mdi mdi-keep-me"'));
  assert.ok(after.includes("\\u4f1a\\u8bdd"));
  assert.deepEqual(scanText(after, { path: "manifest.json" }), []);

  // A second run is a no-op.
  const again = runGenerator(["--write", "--manifest", file]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already current/);
  assert.equal(fs.readFileSync(file, "utf8"), after);
});

test("generate-icons reports a missing key and bad arguments without writing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-icons-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "manifest.json");
  const broken = fixtureManifest().replace(`"${UUID}.skill"`, '"com.example.renamed"');
  fs.writeFileSync(file, broken);

  const missing = runGenerator(["--write", "--manifest", file]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no keyLibrary child with cid "com\.aspen\.flexbar-ai-dashboard\.skill"/);
  assert.equal(fs.readFileSync(file, "utf8"), broken);

  assert.equal(runGenerator(["--size", "7"]).status, 2);
  assert.equal(runGenerator(["--nope"]).status, 2);
});

function runGenerator(args) {
  return spawnSync(process.execPath, [GENERATOR, ...args], { cwd: ROOT, encoding: "utf8" });
}

// Mixed indentation and \u escapes like the real manifest, an unrelated key and a non-style "icon" that must stay.
function fixtureManifest() {
  const child = (name, icon, extra = "") => [
    "          {",
    `              "title": "$${name}.Title",`,
    `              "cid": "${name.startsWith("com.") ? name : `${UUID}.${name}`}",`,
    "              \"style\": {",
    `                  "icon": "${icon}",`,
    "                  \"width\": 240",
    "              },",
    `              "data": {${extra}}`,
    "          }",
  ].join("\n");
  return [
    "{",
    "    \"name\": \"flexbar-ai-dashboard\",",
    "    \"keyLibrary\": {",
    "        \"title\": \"$PluginName\",",
    "        \"style\": {",
    "            \"icon\": \"mdi mdi-puzzle\"",
    "        },",
    "        \"children\": [",
    [
      child("session", "mdi mdi-robot", '"icon": "mdi mdi-data-icon"'),
      child("token-usage", "mdi mdi-counter"),
      child("plan-usage", "mdi mdi-chart-bar"),
      child("com.example.other", "mdi mdi-keep-me"),
      child("reset-timer", "mdi mdi-timer-sand"),
      child("new-session", "mdi mdi-message-plus-outline"),
      child("skill", "mdi mdi-star-four-points"),
      child("dots", "mdi mdi-dots-horizontal"),
    ].join(",\n"),
    "        ]",
    "    },",
    "    \"local\": {",
    "        \"zh\": {",
    "            \"Title\": \"AI \\u4f1a\\u8bdd\"",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
}

async function decodePixels(source) {
  const png = Buffer.isBuffer(source) ? source : Buffer.from(source.slice(source.indexOf(",") + 1), "base64");
  const image = await canvasModule.loadImage(png);
  const canvas = canvasModule.createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height).data;
}

function maxChannelDifference(a, b) {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let index = 0; index < a.length; index += 1) max = Math.max(max, Math.abs(a[index] - b[index]));
  return max;
}

function pixel(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return Array.from(data.subarray(offset, offset + 4));
}

function countColor(data, [r, g, b]) {
  let count = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset] === r && data[offset + 1] === g && data[offset + 2] === b && data[offset + 3] === 255) count += 1;
  }
  return count;
}

function hexToRgb(hex) {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
}

function getPath(value, jsonPath) {
  return jsonPath.reduce((node, part) => node[part], value);
}

function setPath(value, jsonPath, next) {
  getPath(value, jsonPath.slice(0, -1))[jsonPath[jsonPath.length - 1]] = next;
}
