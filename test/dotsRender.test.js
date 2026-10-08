"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const canvasModule = require("@napi-rs/canvas");
const { DOTS_INDICATOR, DOTS_COMPACT_WIDTH, renderDotsKey } = require("../src/dashboard/dotsRender");
const { HEADER_MARK, STATUS_COLORS } = require("../src/dashboard/render");
const { DOTS_FACE, buildDotsFace } = require("../src/dashboard/dotsView");

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function face(kind, overrides = {}) {
  const colors = { safety: "orange", update: "green", working: "blue" };
  return {
    kind,
    color: colors[kind] || "gray",
    hollow: false,
    paused: kind === DOTS_FACE.PAUSED,
    title: `Title ${kind}`,
    detail: `Detail ${kind}`,
    count: 1,
    source: "network",
    updatedAt: NOW,
    ...overrides,
  };
}

// Records texts (with font, color, position), filled and stroked arcs, rectangles and the logo box.
function fakeCanvas({ path2d = false } = {}) {
  const record = { sizes: [], texts: [], arcs: [], rects: [], strokeRects: [], logo: [] };
  if (path2d) record.Path2D = class FakePath2D {};
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    _arc: null,
    _transform: { x: 0, y: 0, scale: 1 },
    _saved: [],
    beginPath() {
      this._arc = null;
    },
    arc(x, y, radius) {
      this._arc = { x, y, radius };
    },
    fill(path) {
      if (record.Path2D && path instanceof record.Path2D) {
        record.logo.push({ x: this._transform.x, y: this._transform.y, size: 24 * this._transform.scale });
        return;
      }
      if (this._arc) record.arcs.push({ ...this._arc, fill: this.fillStyle });
    },
    stroke() {
      if (this._arc) record.arcs.push({ ...this._arc, stroke: this.strokeStyle, lineWidth: this.lineWidth });
    },
    fillRect(x, y, width, height) {
      record.rects.push({ x, y, width, height, color: this.fillStyle });
    },
    strokeRect(x, y, width, height) {
      record.strokeRects.push({ x, y, width, height, color: this.strokeStyle });
    },
    save() {
      this._saved.push({ ...this._transform });
    },
    restore() {
      this._transform = this._saved.pop() || { x: 0, y: 0, scale: 1 };
    },
    translate(x, y) {
      this._transform.x += x;
      this._transform.y += y;
    },
    scale(value) {
      this._transform.scale *= value;
    },
    measureText(text) {
      return { width: String(text).length * 8 };
    },
    fillText(text, x, y) {
      record.texts.push({ text: String(text), x, y, font: this.font, color: this.fillStyle });
    },
  };
  record.createCanvas = (width, height) => {
    record.sizes.push({ width, height });
    return { getContext: () => ctx, toDataURL: () => "data:image/png;base64,fake" };
  };
  return record;
}

const textOf = (record, text) => record.texts.find((item) => item.text === text);

test("every face draws the Dots header, its title and detail, and a status light in its color", () => {
  const kinds = [
    [DOTS_FACE.SAFETY, STATUS_COLORS.orange],
    [DOTS_FACE.UPDATE, STATUS_COLORS.green],
    [DOTS_FACE.WORKING, STATUS_COLORS.blue],
    [DOTS_FACE.IDLE, STATUS_COLORS.gray],
    [DOTS_FACE.NONE, STATUS_COLORS.gray],
    [DOTS_FACE.SIGNED_OUT, STATUS_COLORS.gray],
  ];
  for (const [kind, color] of kinds) {
    const record = fakeCanvas();
    assert.equal(renderDotsKey(face(kind), { width: 240, canvasModule: record }), "data:image/png;base64,fake");
    assert.deepEqual(record.sizes, [{ width: 240, height: 60 }]);
    assert.ok(textOf(record, "Dots"), `${kind}: header`);
    const title = textOf(record, `Title ${kind}`);
    assert.ok(title && /bold 20px/.test(title.font) && title.color === "#ffffff", kind);
    assert.ok(textOf(record, `Detail ${kind}`), kind);
    const light = record.arcs.find((arc) => arc.x === 240 - DOTS_INDICATOR.right && arc.y === DOTS_INDICATOR.y);
    assert.deepEqual([light.fill, light.radius], [color, DOTS_INDICATOR.radius], kind);
  }
});

test("a degraded face gets a hollow ring in its color instead of a filled light", () => {
  const record = fakeCanvas();
  renderDotsKey(face(DOTS_FACE.UPDATE, { hollow: true, detail: "Offline · Cache 5m" }), { width: 240, canvasModule: record });
  const indicatorArcs = record.arcs.filter((arc) => arc.x === 240 - DOTS_INDICATOR.right);
  assert.equal(indicatorArcs.length, 1);
  assert.equal(indicatorArcs[0].stroke, STATUS_COLORS.green);
  assert.equal(indicatorArcs[0].fill, undefined);
  assert.equal(indicatorArcs[0].lineWidth, 2);
  assert.ok(textOf(record, "Offline · Cache 5m"));
});

test("a paused face draws two pause bars, outlined while degraded", () => {
  const solid = fakeCanvas();
  renderDotsKey(face(DOTS_FACE.PAUSED), { width: 240, canvasModule: solid });
  const bars = solid.rects.filter((rect) => rect.color === STATUS_COLORS.gray && rect.height > rect.width);
  assert.equal(bars.length, 2);
  assert.equal(solid.arcs.filter((arc) => arc.x === 240 - DOTS_INDICATOR.right).length, 0, "no dot behind the bars");

  const hollow = fakeCanvas();
  renderDotsKey(face(DOTS_FACE.PAUSED, { hollow: true }), { width: 240, canvasModule: hollow });
  assert.equal(hollow.strokeRects.length, 2);
  assert.ok(hollow.strokeRects.every((rect) => rect.color === STATUS_COLORS.gray));
});

test("the title keeps clear of the light; long text is cut to fit", () => {
  const record = fakeCanvas();
  renderDotsKey(face(DOTS_FACE.UPDATE, { title: "Update ×12 with a very long title indeed", detail: "x".repeat(80) }), { width: 240, canvasModule: record });
  const title = record.texts.find((item) => item.text.startsWith("Update"));
  assert.ok(title.text.endsWith("..."));
  assert.ok(title.x + title.text.length * 8 <= 240 - DOTS_INDICATOR.right - DOTS_INDICATOR.radius - 4);
  const detail = record.texts.find((item) => item.text.startsWith("xxx"));
  assert.ok(detail.text.length * 8 <= 220);
});

test("the header carries the OpenAI mark where Path2D exists", () => {
  const record = fakeCanvas({ path2d: true });
  renderDotsKey(face(DOTS_FACE.IDLE), { width: 240, canvasModule: record });
  assert.deepEqual(record.logo, [{ x: HEADER_MARK.x, y: HEADER_MARK.y, size: HEADER_MARK.size }]);
  assert.equal(textOf(record, "Dots").x, HEADER_MARK.x + HEADER_MARK.size + HEADER_MARK.gap);
});

test("a narrow key shows only the light and the title", () => {
  for (const width of [120, 60]) {
    const record = fakeCanvas({ path2d: true });
    renderDotsKey(face(DOTS_FACE.WORKING, { title: "Work" }), { width, canvasModule: record });
    assert.deepEqual(record.sizes, [{ width, height: 60 }]);
    assert.equal(textOf(record, "Dots"), undefined, `${width}: no header`);
    assert.equal(textOf(record, `Detail ${DOTS_FACE.WORKING}`), undefined, `${width}: no detail`);
    assert.deepEqual(record.logo, []);
    const light = record.arcs.find((arc) => arc.fill === STATUS_COLORS.blue);
    assert.ok(light && light.x < 20, `${width}: light on the left`);
  }
  assert.ok(DOTS_COMPACT_WIDTH > 120 && DOTS_COMPACT_WIDTH <= 140);
  const wide = fakeCanvas();
  renderDotsKey(face(DOTS_FACE.WORKING), { width: DOTS_COMPACT_WIDTH, canvasModule: wide });
  assert.ok(textOf(wide, "Dots"));
});

test("faces built by the view render in both languages, and a missing face shows loading", () => {
  const state = { source: "auto", network: { dots: [{ id: "a", name: "Test Dot", available: true, unread: true }], activity: { a: 0 }, at: NOW }, cache: null, error: null, signedOut: null };
  const zh = fakeCanvas();
  renderDotsKey(buildDotsFace(state, { now: NOW, language: "zh" }), { width: 240, language: "zh", canvasModule: zh });
  assert.ok(textOf(zh, "有新进展"));
  assert.ok(textOf(zh, "Test Dot"));

  const empty = fakeCanvas();
  renderDotsKey(null, { width: 240, canvasModule: empty });
  assert.ok(textOf(empty, "Loading..."));
});

test("real canvas: a filled light, a hollow ring and pause bars land in their colors", async () => {
  const decode = async (uri) => {
    const image = await canvasModule.loadImage(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"));
    const canvas = canvasModule.createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  };
  const cx = 240 - DOTS_INDICATOR.right;
  const cy = DOTS_INDICATOR.y;
  const solid = await decode(renderDotsKey(face(DOTS_FACE.UPDATE), { width: 240, canvasModule }));
  assert.deepEqual(solid(cx, cy), [0x22, 0xc5, 0x5e, 255]);

  const hollow = await decode(renderDotsKey(face(DOTS_FACE.WORKING, { hollow: true }), { width: 240, canvasModule }));
  assert.deepEqual(hollow(cx, cy), [0x05, 0x05, 0x05, 255], "the ring is empty inside");
  const [r, g, b] = hollow(cx + DOTS_INDICATOR.radius, cy);
  assert.ok(b > 150 && b > r, `ring pixel ${r},${g},${b} is blue`);

  const paused = await decode(renderDotsKey(face(DOTS_FACE.PAUSED), { width: 240, canvasModule }));
  assert.deepEqual(paused(cx - 3, cy), [0x71, 0x71, 0x7a, 255]);
  assert.deepEqual(paused(cx, cy), [0x05, 0x05, 0x05, 255], "a gap between the bars");
});
