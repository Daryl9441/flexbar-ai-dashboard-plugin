"use strict";

// The ChatGPT Dots key image: the OpenAI mark and "Dots" at the top left, the state in large type with a status
// light on the right, and one line of detail (dot name, count or the data's age and source) underneath. A degraded
// face has a hollow ring instead of a filled light; a paused one shows pause bars. Keys narrower than about 137px
// keep only the light and the state.

const { normalizeLanguage, t } = require("./i18n");
const { buildDotsFace } = require("./dotsView");
const {
  STATUS_COLORS,
  drawBackground,
  drawHeader,
  drawStatusLight,
  drawText,
  fontSpec,
  renderKey,
} = require("./render");

// The light's center is `right` px from the key's right edge.
const DOTS_INDICATOR = Object.freeze({ right: 16, y: 30, radius: 6 });
const DOTS_COMPACT_WIDTH = 137;
const COMPACT_INDICATOR = Object.freeze({ x: 14, y: 30, radius: 5 });
const TEXT_X = 10;
const TITLE_GAP = 4;
const RING_WIDTH = 2;
const BAR = Object.freeze({ width: 3, gap: 2 });

function renderDotsKey(face, options = {}) {
  const language = normalizeLanguage(options.language);
  const view = face || buildDotsFace(null, { language });
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);
    if (width < DOTS_COMPACT_WIDTH) {
      drawCompact(ctx, width, view);
      return;
    }
    drawHeader(ctx, t(language, "dotsLabel"), width, canvasModule);
    const lightX = width - DOTS_INDICATOR.right;
    drawIndicator(ctx, lightX, DOTS_INDICATOR.y, DOTS_INDICATOR.radius, view);
    drawText(ctx, view.title, TEXT_X, 37, {
      font: fontSpec("bold", 20),
      color: "#ffffff",
      maxWidth: Math.max(1, lightX - DOTS_INDICATOR.radius - TITLE_GAP - TEXT_X),
    });
    drawText(ctx, view.detail, TEXT_X, 54, {
      font: fontSpec("normal", 11),
      color: "#d4d4d8",
      maxWidth: width - TEXT_X * 2,
    });
  });
}

function drawCompact(ctx, width, view) {
  const { x, y, radius } = COMPACT_INDICATOR;
  drawIndicator(ctx, x, y, radius, view);
  const titleX = x + radius + 7;
  drawText(ctx, view.title, titleX, 36, {
    font: fontSpec("bold", 14),
    color: "#ffffff",
    maxWidth: Math.max(1, width - titleX - 6),
  });
}

function drawIndicator(ctx, x, y, radius, view) {
  const color = STATUS_COLORS[view.color] || STATUS_COLORS.gray;
  if (view.paused) {
    drawPauseBars(ctx, x, y, radius, color, view.hollow);
    return;
  }
  if (!view.hollow) {
    drawStatusLight(ctx, x, y, view.color, radius);
    return;
  }
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = RING_WIDTH;
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPauseBars(ctx, x, y, radius, color, hollow) {
  const lefts = [x - BAR.width - BAR.gap / 2, x + BAR.gap / 2];
  const top = y - radius;
  const height = radius * 2;
  for (const left of lefts) {
    if (hollow) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(left) + 0.5, top + 0.5, BAR.width - 1, height - 1);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(left), top, BAR.width, height);
    }
  }
}

module.exports = {
  DOTS_COMPACT_WIDTH,
  DOTS_INDICATOR,
  renderDotsKey,
};
