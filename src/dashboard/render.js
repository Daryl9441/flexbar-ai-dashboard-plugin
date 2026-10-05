"use strict";

const { normalizeLanguage, t } = require("./i18n");

const HEIGHT = 60;
const FONT_FAMILY = resolveFontFamily();

function renderTokenUsageKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  if (view && view.mode === "recentChart") {
    return renderTokenUsageChartKey(view, { ...options, language });
  }

  return renderKey(options, (ctx, width) => {
    drawBackground(ctx, width);
    drawLabel(ctx, view.title || t(language, "tokenUsageTitle"), 10, 13);
    drawText(ctx, view.label || t(language, "unknown"), width / 2, 39, {
      font: fontSpec("bold", 30),
      align: "center",
      maxWidth: width - 20,
    });
  });
}

function renderTokenUsageChartKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width) => {
    drawBackground(ctx, width);
    drawLabel(ctx, view.recentLabel || t(language, "recentUsage"), 10, 13);
    drawText(ctx, view.label || "", width - 8, 13, {
      font: fontSpec("bold", 11),
      align: "right",
      color: "#f4f4f5",
      maxWidth: Math.max(44, width - 120),
    });

    const items = Array.isArray(view.recent) ? view.recent.slice(-12) : [];
    if (items.length === 0) {
      drawText(ctx, t(language, "noRecentUsage"), width / 2, 39, {
        font: fontSpec("bold", 18),
        align: "center",
        color: "#f4f4f5",
        maxWidth: width - 20,
      });
      return;
    }

    const left = 10;
    const right = width - 10;
    const bottom = 47;
    const chartHeight = 23;
    const gap = 3;
    const labelY = 58;
    const barWidth = Math.max(3, Math.floor((right - left - gap * (items.length - 1)) / items.length));
    items.forEach((item, index) => {
      const intensity = clampPercent(item.intensity);
      const barHeight = Math.max(2, Math.round(chartHeight * intensity / 100));
      const x = left + index * (barWidth + gap);
      const y = bottom - barHeight;
      drawRoundedRect(ctx, x, y, barWidth, barHeight, 2, tokenBarColor(intensity));
      drawText(ctx, tokenBarLabel(item), x + barWidth / 2, labelY, {
        font: fontSpec("bold", 8),
        align: "center",
        color: "#d4d4d8",
        maxWidth: Math.max(18, barWidth + gap + 8),
      });
    });
  });
}

function renderPlanUsageKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width) => {
    drawBackground(ctx, width);
    drawLabel(ctx, view.title || t(language, "planUsageTitle"), 10, 13);

    const items = Array.isArray(view.items) ? view.items.slice(0, 2) : [];
    if (items.length === 0) {
      drawText(ctx, t(language, "unavailable"), width / 2, 39, {
        font: fontSpec("bold", 22),
        align: "center",
        color: "#f4f4f5",
        maxWidth: width - 20,
      });
      return;
    }

    const percentWidth = 44;
    const percentGap = 8;
    const percentRight = width - 8;
    // The label column fits the widest label (e.g. "Monthly"), within limits.
    ctx.font = fontSpec("normal", 11);
    const widestLabel = Math.max(...items.map((item) => ctx.measureText(String(item.label || "")).width));
    const labelWidth = Math.min(72, Math.max(42, Math.ceil(widestLabel) + 4));
    const barX = 10 + labelWidth;
    const barWidth = Math.max(40, percentRight - percentWidth - percentGap - barX);
    items.forEach((item, index) => {
      const y = 25 + index * 17;
      drawText(ctx, item.label, 10, y + 8, {
        font: fontSpec("normal", 11),
        color: "#f4f4f5",
        maxWidth: labelWidth - 2,
      });
      drawRoundedRect(ctx, barX, y, barWidth, 9, 4, "#27272a");
      drawRoundedRect(ctx, barX, y, Math.round(barWidth * (item.remainingPercent / 100)), 9, 4, quotaColor(item.remainingPercent));
      drawText(ctx, `${item.remainingPercent}%`, percentRight, y + 8, {
        font: fontSpec("bold", 12),
        align: "right",
        color: "#f4f4f5",
        maxWidth: percentWidth,
      });
    });
  });
}

function renderResetTimerKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return renderKey(options, (ctx, width) => {
    drawBackground(ctx, width);

    const items = Array.isArray(view.items) ? view.items.slice(0, 2) : [];
    if (items.length === 0) {
      drawText(ctx, t(language, "unavailable"), width / 2, 36, {
        font: fontSpec("bold", 22),
        align: "center",
        color: "#f4f4f5",
        maxWidth: width - 20,
      });
      return;
    }

    const count = items.length;
    const cy = 25;
    const rOuter = 16;
    const rInner = 11;
    items.forEach((item, index) => {
      const cx = Math.round((width * (index + 0.5)) / count);
      // Without a known window length there is no fraction: track only, time still shown.
      const windowMs = Number(item.windowSeconds) > 0 ? Number(item.windowSeconds) * 1000 : Infinity;
      const remainingMs = Math.max(0, Number(item.resetAtMs) - now);
      const fraction = Math.max(0, Math.min(1, remainingMs / windowMs));

      // Full track, then a time arc that starts full at 12 o'clock and drains
      // clockwise toward empty as the reset approaches.
      fillRing(ctx, cx, cy, rOuter, rInner, -Math.PI / 2, Math.PI * 1.5, "#27272a");
      if (fraction > 0) {
        fillRing(ctx, cx, cy, rOuter, rInner, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2, TIMER_COLOR);
      }

      drawText(ctx, formatResetRemaining(remainingMs), cx, cy + 4, {
        font: fontSpec("bold", 13),
        align: "center",
        color: "#f4f4f5",
        maxWidth: rInner * 2 + 6,
      });
      drawText(ctx, item.label, cx, 52, {
        font: fontSpec("normal", 10),
        align: "center",
        color: "#d4d4d8",
        maxWidth: Math.round(width / count) - 8,
      });
    });
  });
}

function renderSessionKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width) => {
    drawBackground(ctx, width);

    const padding = 8;
    const statusX = width - 14;
    const tokenRight = statusX - 16;
    const tokenWidth = Math.min(112, Math.max(60, Math.round(width * 0.22)));
    const titleMaxWidth = Math.max(40, tokenRight - tokenWidth - padding - 8);

    drawText(ctx, view.title || t(language, "untitled"), padding, 24, {
      font: fontSpec("bold", 18),
      color: "#ffffff",
      maxWidth: titleMaxWidth,
    });
    drawText(ctx, view.tokenLabel || t(language, "unknown"), tokenRight, 24, {
      font: fontSpec("bold", 18),
      align: "right",
      color: "#ffffff",
      maxWidth: tokenWidth,
    });
    drawStatusLight(ctx, statusX, 18, view.statusColor);
    drawText(ctx, view.activity || t(language, "activityCompleted"), padding, 49, {
      font: fontSpec("normal", 12),
      align: "left",
      color: "#f4f4f5",
      maxWidth: width - padding * 2,
    });
  });
}

const OVERVIEW_ROWS = 3;
const OVERVIEW_ROW_GAP = 18;
const OVERVIEW_PADDING = 8;
const OVERVIEW_MIN_COLUMN_WIDTH = 110;
const OVERVIEW_WIDE_COLUMN_WIDTH = 150;

// Grid of a session overview key: as many 3-row columns of at least 110px as the
// key holds; when the sessions do not all fit, the last slot shows "+N". Only as
// many columns as the sessions need are used, so a few titles get wide columns.
function sessionOverviewLayout(width, itemCount) {
  const inner = keyCanvasWidth(width) - OVERVIEW_PADDING * 2;
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  const maxColumns = Math.max(1, Math.floor(inner / OVERVIEW_MIN_COLUMN_WIDTH));
  const capacity = maxColumns * OVERVIEW_ROWS;
  const visibleCount = count > capacity ? capacity - 1 : count;
  const columns = Math.min(maxColumns, Math.max(1, Math.ceil(count / OVERVIEW_ROWS)));
  const columnWidth = inner / columns;
  return {
    columns,
    columnWidth,
    capacity,
    visibleCount,
    hiddenCount: count - visibleCount,
    rows: Math.max(1, Math.min(OVERVIEW_ROWS, count)),
    fontSize: columnWidth >= OVERVIEW_WIDE_COLUMN_WIDTH ? 13 : 12,
  };
}

// Session overview: a status dot + title per session, filling columns top to
// bottom; blue = running, orange = awaiting approval, green = done.
function renderSessionOverviewKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width) => {
    drawBackground(ctx, width);

    const items = Array.isArray(view && view.items) ? view.items : [];
    if (items.length === 0) {
      drawText(ctx, t(language, "noActiveSessions"), width / 2, 36, {
        font: fontSpec("bold", 16),
        align: "center",
        color: "#d4d4d8",
        maxWidth: width - 20,
      });
      return;
    }

    const layout = sessionOverviewLayout(width, items.length);
    const { columnWidth, fontSize } = layout;
    // Rows are centered vertically, so one or two sessions do not hug the top edge.
    const firstRowY = HEIGHT / 2 - ((layout.rows - 1) * OVERVIEW_ROW_GAP) / 2;
    const slot = (index) => ({
      x: OVERVIEW_PADDING + Math.floor(index / OVERVIEW_ROWS) * columnWidth,
      y: firstRowY + (index % OVERVIEW_ROWS) * OVERVIEW_ROW_GAP,
    });
    const baseline = (y) => y + Math.round(fontSize * 0.35 * 2) / 2;
    const textMaxWidth = columnWidth - 21;

    items.slice(0, layout.visibleCount).forEach((item, index) => {
      const { x, y } = slot(index);
      const done = item.status === "done";
      drawStatusLight(ctx, x + 5, y, item.statusColor, 4.5);
      drawText(ctx, item.title || t(language, "untitled"), x + 15, baseline(y), {
        font: fontSpec(done ? "normal" : "bold", fontSize),
        color: done ? "#d4d4d8" : "#ffffff",
        maxWidth: textMaxWidth,
      });
    });

    if (layout.hiddenCount > 0) {
      // Blue while "+N" hides a session that is still running or waiting.
      const hidesActive = items.slice(layout.visibleCount).some((item) => item.status !== "done");
      const { x, y } = slot(layout.capacity - 1);
      drawText(ctx, `+${layout.hiddenCount}`, x + 15, baseline(y), {
        font: fontSpec("bold", fontSize),
        color: hidesActive ? STATUS_COLORS.blue : "#a1a1aa",
        maxWidth: textMaxWidth,
      });
    }
  });
}

function renderSkillKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width) => {
    drawBackground(ctx, width);
    drawLabel(ctx, `${view.skillLabel || t(language, "skillLabel")} - ${view.sourceLabel || "Codex"}`, 10, 13);
    drawText(ctx, view.title || t(language, "selectSkill"), 10, 35, {
      font: fontSpec("bold", 20),
      color: "#ffffff",
      maxWidth: width - 20,
    });
    drawText(ctx, view.activity || t(language, "tapToUseSkill"), 10, 52, {
      font: fontSpec("normal", 11),
      color: "#d4d4d8",
      maxWidth: width - 20,
    });
  });
}

function renderNewSessionKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width) => {
    drawBackground(ctx, width);
    drawLabel(ctx, view.label || t(language, "newSessionLabel"), 10, 13);

    const iconX = 22;
    const iconY = 34;
    ctx.beginPath();
    ctx.fillStyle = "#22c55e";
    ctx.arc(iconX, iconY, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#050505";
    ctx.fillRect(iconX - 6, iconY - 1.5, 12, 3);
    ctx.fillRect(iconX - 1.5, iconY - 6, 3, 12);

    const textX = iconX + 18;
    drawText(ctx, view.title || t(language, "newSessionAction"), textX, 40, {
      font: fontSpec("bold", 20),
      color: "#ffffff",
      maxWidth: width - textX - 8,
    });
    drawText(ctx, view.project || t(language, "newSessionDefaultProject"), 10, 56, {
      font: fontSpec("normal", 10),
      color: "#d4d4d8",
      maxWidth: width - 20,
    });
  });
}

function keyCanvasWidth(width) {
  return Math.max(60, Math.round(Number(width) || 240));
}

function renderKey(options, draw) {
  const width = keyCanvasWidth(options.width);
  const canvasModule = options.canvasModule === undefined ? loadCanvasModule() : options.canvasModule;
  if (!canvasModule || typeof canvasModule.createCanvas !== "function") {
    throw new Error("@napi-rs/canvas is required to render Flexbar PNG key images");
  }

  const canvas = canvasModule.createCanvas(width, HEIGHT);
  const ctx = canvas.getContext("2d");
  draw(ctx, width);
  return canvas.toDataURL("image/png");
}

function loadCanvasModule() {
  try {
    return require("@napi-rs/canvas");
  } catch {
    return null;
  }
}

function drawBackground(ctx, width) {
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, width, HEIGHT);
}

function drawLabel(ctx, label, x, y) {
  drawText(ctx, label, x, y, {
    font: fontSpec("normal", 11),
    color: "#d4d4d8",
    maxWidth: 120,
  });
}

const STATUS_COLORS = {
  orange: "#f97316",
  green: "#22c55e",
  blue: "#38bdf8",
  gray: "#71717a",
};

function drawStatusLight(ctx, x, y, colorName, radius = 6) {
  const fill = STATUS_COLORS[colorName] || STATUS_COLORS.gray;

  ctx.beginPath();
  ctx.fillStyle = fill;
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function quotaColor(remainingPercent) {
  const value = Number(remainingPercent);
  if (!Number.isFinite(value)) return "#71717a";
  if (value < 20) return "#ef4444";
  if (value < 50) return "#f59e0b";
  return "#22c55e";
}

const TIMER_COLOR = "#38bdf8";

function fillRing(ctx, cx, cy, rOuter, rInner, startAngle, endAngle, color) {
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, startAngle, endAngle, false);
  ctx.arc(cx, cy, rInner, endAngle, startAngle, true);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function formatResetRemaining(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

function tokenBarColor(intensity) {
  const value = Number(intensity);
  if (!Number.isFinite(value)) return "#71717a";
  if (value >= 75) return "#ef4444";
  if (value >= 35) return "#f59e0b";
  return "#22c55e";
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const absolute = Math.abs(number);
  if (absolute >= 1000000) return `${Math.round(number / 1000000)}m`;
  if (absolute >= 1000) return `${Math.round(number / 1000)}k`;
  return String(Math.round(number));
}

function tokenBarLabel(item) {
  if (item && item.value !== undefined) return formatCompactNumber(item.value);
  return String(item && item.label || "").replace(/\.\d+(?=[kKmM]?$)/, "");
}

function drawText(ctx, text, x, y, options = {}) {
  ctx.fillStyle = options.color || "#ffffff";
  ctx.font = options.font || fontSpec("normal", 12);
  ctx.textAlign = options.align || "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(fitText(ctx, text, options.maxWidth || Infinity), x, y);
}

function fitText(ctx, value, maxWidth) {
  const text = String(value || "");
  if (!Number.isFinite(maxWidth) || ctx.measureText(text).width <= maxWidth) return text;
  if (maxWidth <= ctx.measureText("...").width) return "";

  let result = text;
  while (result.length > 0 && ctx.measureText(`${result}...`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}...`;
}

function fontSpec(weight, size) {
  const prefix = weight && weight !== "normal" ? `${weight} ` : "";
  return `${prefix}${size}px ${FONT_FAMILY}`;
}

function resolveFontFamily() {
  if (process.platform === "win32") {
    return '"Microsoft YaHei UI", "Microsoft YaHei", SimHei, "Segoe UI", "Noto Sans CJK SC", Arial, sans-serif';
  }
  if (process.platform === "darwin") {
    return '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", Arial, sans-serif';
  }
  return '"Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Micro Hei", Arial, sans-serif';
}

function drawRoundedRect(ctx, x, y, width, height, radius, color) {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  const safeRadius = Math.min(radius, safeWidth / 2, safeHeight / 2);

  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + safeWidth - safeRadius, y);
  ctx.quadraticCurveTo(x + safeWidth, y, x + safeWidth, y + safeRadius);
  ctx.lineTo(x + safeWidth, y + safeHeight - safeRadius);
  ctx.quadraticCurveTo(x + safeWidth, y + safeHeight, x + safeWidth - safeRadius, y + safeHeight);
  ctx.lineTo(x + safeRadius, y + safeHeight);
  ctx.quadraticCurveTo(x, y + safeHeight, x, y + safeHeight - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

module.exports = {
  HEIGHT,
  renderNewSessionKey,
  renderPlanUsageKey,
  renderResetTimerKey,
  renderSessionKey,
  renderSessionOverviewKey,
  renderSkillKey,
  renderTokenUsageKey,
  sessionOverviewLayout,
  fontSpec,
  quotaColor,
  tokenBarColor,
};
