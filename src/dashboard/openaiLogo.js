"use strict";

// The OpenAI mark, drawn as a vector so key images and key-library icons show at
// a glance that the data comes from Codex / ChatGPT.
//
// Path: icons/openai.svg (viewBox 0 0 24 24) of Simple Icons as of simple-icons@15.22.0.
// Simple Icons removed the icon in 16.0.0 (simple-icons pull request #13944) for want of
// OpenAI's permission, so no CC0-1.0 licence is claimed for it here: OpenAI and its logo
// are trademarks of OpenAI, and their use is subject to OpenAI's brand guidelines
// (https://openai.com/brand). The mark only identifies the data source.
const OPENAI_LOGO_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 " +
  "4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 " +
  "6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 " +
  "5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 " +
  "1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 " +
  ".038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 " +
  "4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 " +
  "4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l" +
  "5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 " +
  "3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 " +
  "8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 " +
  "9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 " +
  "12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 " +
  "5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const LOGO_VIEWBOX = 24;

const TILE_COLOR = "#0d0d0d";
const LOGO_COLOR = "#ffffff";
const GLYPH_COLOR = "#0d0d0d";

// Icon geometry, as fractions of the icon size.
const TILE_RADIUS = 0.23;
const LOGO_SIZE = 0.66;
const BADGED_LOGO_SIZE = 0.6;
const BADGED_LOGO_OFFSET = 0.07;
const BADGE_RADIUS = 0.205;
const BADGE_CENTER = 0.755;
const BADGE_RING = 0.04;

const MIN_ICON_SIZE = 16;
const MAX_ICON_SIZE = 1024;

const PLUGIN_UUID = "com.aspen.flexbar-ai-dashboard";

/**
 * Badge name -> { color, glyph, draw(ctx, cx, cy, r) }. `draw` paints the glyph in the dark glyph color inside a
 * badge circle of radius r centered on (cx, cy); every glyph is a vector, so no font is needed.
 */
const ICON_BADGES = Object.freeze({
  session: badge("#38bdf8", "list", drawListGlyph),
  token: badge("#a78bfa", "hash", drawHashGlyph),
  plan: badge("#22c55e", "bars", drawBarsGlyph),
  reset: badge("#38bdf8", "clock", drawClockGlyph),
  newSession: badge("#22c55e", "plus", drawPlusGlyph),
  skill: badge("#facc15", "star", drawStarGlyph),
});

/**
 * Manifest icon target -> badge name (null: the plain logo). "keyLibrary" is keyLibrary.style.icon, every other
 * target is the style.icon of the keyLibrary child with that cid.
 */
const ICON_SPECS = Object.freeze({
  keyLibrary: null,
  [`${PLUGIN_UUID}.session`]: "session",
  [`${PLUGIN_UUID}.token-usage`]: "token",
  [`${PLUGIN_UUID}.plan-usage`]: "plan",
  [`${PLUGIN_UUID}.reset-timer`]: "reset",
  [`${PLUGIN_UUID}.new-session`]: "newSession",
  [`${PLUGIN_UUID}.skill`]: "skill",
});

// Canvas module -> its parsed Path2D of the logo, so the path string is parsed once per module.
const pathCache = new WeakMap();
let globalPath = null;

/**
 * Draws the OpenAI mark into the square (x, y, size, size). Returns true when drawn, false (drawing nothing) when no
 * Path2D is available or drawing fails; it never throws. The caller's transform and styles are left untouched.
 */
function drawOpenAiLogo(ctx, x, y, size, color = LOGO_COLOR, canvasModule) {
  const box = Number(size);
  if (!ctx || !Number.isFinite(box) || box <= 0 || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    return false;
  }
  const path = logoPath(canvasModule === undefined ? loadCanvasModule() : canvasModule);
  if (!path) return false;

  let saved = false;
  try {
    ctx.save();
    saved = true;
    ctx.translate(Number(x), Number(y));
    ctx.scale(box / LOGO_VIEWBOX, box / LOGO_VIEWBOX);
    ctx.fillStyle = color || LOGO_COLOR;
    ctx.fill(path);
    return true;
  } catch {
    return false;
  } finally {
    if (saved) {
      try {
        ctx.restore();
      } catch {
        // The context is unusable; nothing left to undo.
      }
    }
  }
}

/**
 * Renders a key-library icon: the white logo on a dark rounded tile, optionally with a colored badge (a name from
 * ICON_BADGES) at the bottom-right. Returns a "data:image/png;base64,..." URI of size x size pixels.
 */
function renderOpenAiIcon({ size = 96, badge: badgeName = null, canvasModule } = {}) {
  const pixels = Number(size);
  if (!Number.isInteger(pixels) || pixels < MIN_ICON_SIZE || pixels > MAX_ICON_SIZE) {
    throw new RangeError(`Icon size must be an integer from ${MIN_ICON_SIZE} to ${MAX_ICON_SIZE}, got ${size}`);
  }
  const spec = badgeName == null ? null : ICON_BADGES[badgeName];
  if (badgeName != null && (!spec || !Object.prototype.hasOwnProperty.call(ICON_BADGES, badgeName))) {
    throw new Error(`Unknown icon badge "${badgeName}"`);
  }
  const canvasLib = canvasModule === undefined ? loadCanvasModule() : canvasModule;
  if (!canvasLib || typeof canvasLib.createCanvas !== "function") {
    throw new Error("@napi-rs/canvas is required to render the OpenAI icon");
  }

  const canvas = canvasLib.createCanvas(pixels, pixels);
  const ctx = canvas.getContext("2d");
  roundedSquarePath(ctx, 0, 0, pixels, TILE_RADIUS * pixels);
  ctx.fillStyle = TILE_COLOR;
  ctx.fill();

  const logoSize = (spec ? BADGED_LOGO_SIZE : LOGO_SIZE) * pixels;
  const logoOffset = spec ? BADGED_LOGO_OFFSET * pixels : (pixels - logoSize) / 2;
  if (!drawOpenAiLogo(ctx, logoOffset, logoOffset, logoSize, LOGO_COLOR, canvasLib)) {
    throw new Error("Path2D is required to render the OpenAI icon");
  }

  if (spec) {
    const center = BADGE_CENTER * pixels;
    const radius = BADGE_RADIUS * pixels;
    // A ring in the tile color separates the badge from the logo; clipped to the tile so it never shows outside it.
    ctx.save();
    roundedSquarePath(ctx, 0, 0, pixels, TILE_RADIUS * pixels);
    ctx.clip();
    fillCircle(ctx, center, center, radius + BADGE_RING * pixels, TILE_COLOR);
    ctx.restore();
    fillCircle(ctx, center, center, radius, spec.color);
    ctx.save();
    spec.draw(ctx, center, center, radius);
    ctx.restore();
  }
  return canvas.toDataURL("image/png");
}

// The logo as a Path2D of the given canvas module, or of the global Path2D (a browser) when there is no module.
function logoPath(canvasModule) {
  try {
    if (canvasModule == null) {
      if (!globalPath && typeof globalThis.Path2D === "function") globalPath = new globalThis.Path2D(OPENAI_LOGO_PATH);
      return globalPath;
    }
    if (typeof canvasModule.Path2D !== "function") return null;
    let path = pathCache.get(canvasModule);
    if (!path) {
      path = new canvasModule.Path2D(OPENAI_LOGO_PATH);
      pathCache.set(canvasModule, path);
    }
    return path;
  } catch {
    return null;
  }
}

function loadCanvasModule() {
  try {
    return require("@napi-rs/canvas");
  } catch {
    return null;
  }
}

function badge(color, glyph, draw) {
  return Object.freeze({ color, glyph, draw });
}

function roundedSquarePath(ctx, x, y, size, radius) {
  const r = Math.min(radius, size / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + size - r, y);
  ctx.arcTo(x + size, y, x + size, y + r, r);
  ctx.lineTo(x + size, y + size - r);
  ctx.arcTo(x + size, y + size, x + size - r, y + size, r);
  ctx.lineTo(x + r, y + size);
  ctx.arcTo(x, y + size, x, y + size - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function fillCircle(ctx, cx, cy, r, color) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function strokeLines(ctx, lines, width, cap = "round") {
  ctx.strokeStyle = GLYPH_COLOR;
  ctx.lineWidth = width;
  ctx.lineCap = cap;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of lines) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
}

// Three rows of a dot and a line.
function drawListGlyph(ctx, cx, cy, r) {
  const rows = [-0.42, 0, 0.42];
  for (const row of rows) fillCircle(ctx, cx - 0.42 * r, cy + row * r, 0.13 * r, GLYPH_COLOR);
  strokeLines(ctx, rows.map((row) => [cx - 0.12 * r, cy + row * r, cx + 0.5 * r, cy + row * r]), 0.2 * r);
}

// "#": two slanted uprights and two cross bars.
function drawHashGlyph(ctx, cx, cy, r) {
  const e = 0.54 * r;
  const slant = 0.1 * r;
  strokeLines(ctx, [
    [cx - 0.19 * r + slant, cy - e, cx - 0.19 * r - slant, cy + e],
    [cx + 0.21 * r + slant, cy - e, cx + 0.21 * r - slant, cy + e],
    [cx - e, cy - 0.19 * r, cx + e, cy - 0.19 * r],
    [cx - e, cy + 0.2 * r, cx + e, cy + 0.2 * r],
  ], 0.19 * r, "butt");
}

// Three bottom-aligned bars of increasing height.
function drawBarsGlyph(ctx, cx, cy, r) {
  const width = 0.26 * r;
  const gap = 0.11 * r;
  const bottom = cy + 0.48 * r;
  const left = cx - (3 * width + 2 * gap) / 2;
  ctx.fillStyle = GLYPH_COLOR;
  [0.42, 0.68, 0.96].forEach((height, index) => {
    ctx.fillRect(left + index * (width + gap), bottom - height * r, width, height * r);
  });
}

// A clock face with its hands at three o'clock.
function drawClockGlyph(ctx, cx, cy, r) {
  ctx.strokeStyle = GLYPH_COLOR;
  ctx.lineWidth = 0.18 * r;
  ctx.beginPath();
  ctx.arc(cx, cy, 0.52 * r, 0, Math.PI * 2);
  ctx.stroke();
  strokeLines(ctx, [
    [cx, cy, cx, cy - 0.3 * r],
    [cx, cy, cx + 0.24 * r, cy],
  ], 0.17 * r);
}

function drawPlusGlyph(ctx, cx, cy, r) {
  const e = 0.48 * r;
  strokeLines(ctx, [
    [cx - e, cy, cx + e, cy],
    [cx, cy - e, cx, cy + e],
  ], 0.24 * r);
}

// A four-point star with concave sides.
function drawStarGlyph(ctx, cx, cy, r) {
  const outer = 0.7 * r;
  const inner = 0.12 * r;
  ctx.fillStyle = GLYPH_COLOR;
  ctx.beginPath();
  ctx.moveTo(cx, cy - outer);
  ctx.quadraticCurveTo(cx + inner, cy - inner, cx + outer, cy);
  ctx.quadraticCurveTo(cx + inner, cy + inner, cx, cy + outer);
  ctx.quadraticCurveTo(cx - inner, cy + inner, cx - outer, cy);
  ctx.quadraticCurveTo(cx - inner, cy - inner, cx, cy - outer);
  ctx.closePath();
  ctx.fill();
}

module.exports = {
  ICON_BADGES,
  ICON_SPECS,
  OPENAI_LOGO_PATH,
  drawOpenAiLogo,
  renderOpenAiIcon,
};
