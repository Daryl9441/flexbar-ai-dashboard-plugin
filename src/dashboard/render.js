"use strict";

const { normalizeLanguage, t } = require("./i18n");
const { ICON_BADGES, drawOpenAiLogo } = require("./openaiLogo");

const HEIGHT = 60;
const FONT_FAMILY = resolveFontFamily();
const BACKGROUND_COLOR = "#050505";

// The white OpenAI mark tells at a glance that a key shows Codex / ChatGPT data. It is
// drawn left of a key's header label (the reset timer, which has none, has it in the
// same top-left spot), leading the first line of the AI Session key's three views, and
// with a green "+" badge on New Codex Session. Where it would squeeze or touch the
// key's content (on a narrow key) it is left out, as it is without Path2D or on any
// drawing error, and the content keeps its old place.
const MARK_COLOR = "#ffffff";
const HEADER_MARK = Object.freeze({ x: 10, y: 3, size: 12, gap: 4 });
// Least room between the mark and the content it keeps clear of (a reset ring, the token total).
const MARK_CLEARANCE = 2;
const HEADER_LABEL_Y = 13;
const HEADER_LABEL_MAX_WIDTH = 120;
// The AI Session views: the 16px mark level with the first line (the title, the first
// row, or the message), and the content beside it from SESSION_CONTENT_X.
const SESSION_MARK = Object.freeze({ x: 8, y: 10, size: 16, gap: 6 });
const SESSION_CONTENT_X = SESSION_MARK.x + SESSION_MARK.size + SESSION_MARK.gap;
const SESSION_MIN_TITLE_WIDTH = 40;
// The session title keeps at least this much beside the mark, else there is no mark
// (keys under about 218px; the default is 520px).
const SESSION_MARK_MIN_TITLE_WIDTH = 90;
// New Codex Session: the mark with a green "+" badge at its bottom right (the key's
// key-library icon) in a column left of all three text lines, so its header needs no
// second mark. A key too narrow to leave the text NEW_SESSION_MIN_TEXT_WIDTH beside
// that column (under about 137px) keeps the compact layout: the header mark and label,
// then a green "+" circle left of the title.
const NEW_SESSION_MARK = Object.freeze({ x: 9, y: 14, size: 25, badgeRadius: 7, badgeRing: 1.5, textGap: 7 });
const NEW_SESSION_MIN_TEXT_WIDTH = 80;

function renderTokenUsageKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  if (view && view.mode === "recentChart") {
    return renderTokenUsageChartKey(view, { ...options, language });
  }

  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);
    const total = view.label || t(language, "unknown");
    const totalFont = fontSpec("bold", 30);
    const totalMaxWidth = width - 20;
    ctx.font = totalFont;
    const totalWidth = Math.min(totalMaxWidth, ctx.measureText(String(total)).width);
    // The 30px total reaches up to the mark's bottom row: the mark only while the total
    // starts right of it (a long total on a narrow key would touch it).
    const totalClear = width / 2 - totalWidth / 2 >= HEADER_MARK.x + HEADER_MARK.size + MARK_CLEARANCE;
    drawHeader(ctx, view.title || t(language, "tokenUsageTitle"), width, canvasModule, { mark: totalClear });
    drawText(ctx, total, width / 2, 39, {
      font: totalFont,
      align: "center",
      maxWidth: totalMaxWidth,
    });
  });
}

function renderTokenUsageChartKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);
    const total = String(view.label || "");
    const totalFont = fontSpec("bold", 11);
    const totalMaxWidth = Math.max(44, width - 120);
    ctx.font = totalFont;
    const totalWidth = total ? Math.min(totalMaxWidth, Math.ceil(ctx.measureText(total).width)) : 0;
    // The header stops short of the total on the right.
    drawHeader(ctx, view.recentLabel || t(language, "recentUsage"), width, canvasModule, {
      right: width - 8 - (totalWidth ? totalWidth + 8 : 0),
    });
    drawText(ctx, total, width - 8, HEADER_LABEL_Y, {
      font: totalFont,
      align: "right",
      color: "#f4f4f5",
      maxWidth: totalMaxWidth,
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
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);
    drawHeader(ctx, view.title || t(language, "planUsageTitle"), width, canvasModule);

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
    const barWidth = percentRight - percentWidth - percentGap - barX;
    const showBar = barWidth >= 32;
    items.forEach((item, index) => {
      const y = 20 + index * 21;
      drawText(ctx, item.label, 10, y + 8, {
        font: fontSpec("normal", 11),
        color: "#f4f4f5",
        maxWidth: labelWidth - 2,
      });
      if (showBar) {
        drawRoundedRect(ctx, barX, y, barWidth, 7, 3, "#27272a");
        drawRoundedRect(ctx, barX, y, Math.round(barWidth * (item.remainingPercent / 100)), 7, 3, quotaColor(item.remainingPercent));
      }
      drawText(ctx, `${item.remainingPercent}%`, percentRight, y + 8, {
        font: fontSpec("bold", 12),
        align: "right",
        color: "#f4f4f5",
        maxWidth: percentWidth,
      });
      drawText(ctx, planResetLabel(item.resetAtMs, now, language), 10, y + 17, {
        font: fontSpec("normal", 9),
        color: "#a1a1aa",
        maxWidth: width - 18,
      });
    });
  });
}

// Absolute local time per quota window. Never infer a new reset from a stale one.
function planResetLabel(resetAtMs, now, language) {
  const prefix = t(language, "planResets");
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0 || !Number.isFinite(new Date(resetAtMs).getTime())) {
    return `${prefix} —`;
  }
  if (resetAtMs <= now) return t(language, "planResetPending");
  const reset = new Date(resetAtMs);
  const current = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(reset.getHours())}:${pad(reset.getMinutes())}`;
  const date = `${pad(reset.getMonth() + 1)}/${pad(reset.getDate())}`;
  const year = reset.getFullYear() === current.getFullYear() ? "" : `${reset.getFullYear()}/`;
  return `${prefix} ${year}${date} ${time}`;
}

function renderResetTimerKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);

    const items = Array.isArray(view.items) ? view.items.slice(0, 2) : [];
    if (items.length === 0) {
      drawMark(ctx, HEADER_MARK.x, HEADER_MARK.y, HEADER_MARK.size, canvasModule);
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
    const ringCenters = items.map((_, index) => Math.round((width * (index + 0.5)) / count));
    // The mark where the other keys have theirs, only where it keeps clear of every ring
    // (a narrow key has none).
    const markClear = ringCenters.every((cx) =>
      distanceToBox(cx, cy, HEADER_MARK.x, HEADER_MARK.y, HEADER_MARK.size) >= rOuter + MARK_CLEARANCE
    );
    if (markClear) drawMark(ctx, HEADER_MARK.x, HEADER_MARK.y, HEADER_MARK.size, canvasModule);
    items.forEach((item, index) => {
      const cx = ringCenters[index];
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
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);

    const padding = 8;
    const statusX = width - 14;
    const tokenRight = statusX - 16;
    const tokenWidth = Math.min(112, Math.max(60, Math.round(width * 0.22)));
    const titleRoom = (x) => tokenRight - tokenWidth - x - 8;
    // The mark only while the title keeps a usable width beside it.
    const marked = titleRoom(SESSION_CONTENT_X) >= SESSION_MARK_MIN_TITLE_WIDTH &&
      drawMark(ctx, SESSION_MARK.x, SESSION_MARK.y, SESSION_MARK.size, canvasModule);
    const titleX = marked ? SESSION_CONTENT_X : padding;
    const titleMaxWidth = Math.max(SESSION_MIN_TITLE_WIDTH, titleRoom(titleX));

    drawText(ctx, view.title || t(language, "untitled"), titleX, 24, {
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
// `left` is where the grid starts (right of the mark when it has one).
function sessionOverviewLayout(width, itemCount, left = OVERVIEW_PADDING) {
  const inner = keyCanvasWidth(width) - left - OVERVIEW_PADDING;
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  const maxColumns = Math.max(1, Math.floor(inner / OVERVIEW_MIN_COLUMN_WIDTH));
  const capacity = maxColumns * OVERVIEW_ROWS;
  const visibleCount = count > capacity ? capacity - 1 : count;
  const columns = Math.min(maxColumns, Math.max(1, Math.ceil(count / OVERVIEW_ROWS)));
  const columnWidth = inner / columns;
  return {
    left,
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
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);

    const items = Array.isArray(view && view.items) ? view.items : [];
    if (items.length === 0) {
      drawListMessage(ctx, t(language, "noActiveSessions"), 16, width, canvasModule);
      return;
    }

    const layout = drawListMark(ctx, sessionOverviewLayout, width, items.length, canvasModule);
    const { columnWidth, fontSize } = layout;
    const firstRowY = listFirstRowY(layout.rows);
    const slot = (index) => ({
      x: layout.left + Math.floor(index / OVERVIEW_ROWS) * columnWidth,
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

// Rows are centered vertically, so one or two of them do not hug the top edge.
function listFirstRowY(rows) {
  return HEIGHT / 2 - ((rows - 1) * OVERVIEW_ROW_GAP) / 2;
}

// The all-sessions and scheduled-tasks grids: the mark in a column of its own, level
// with the first row, and the grid right of it from where the session title starts,
// only while that costs the grid no slot and no font size (a 520px key, not a 240px
// one). Returns the layout to draw the grid with.
function drawListMark(ctx, layoutFor, width, count, canvasModule) {
  const plain = layoutFor(width, count);
  const beside = layoutFor(width, count, SESSION_CONTENT_X);
  if (beside.capacity !== plain.capacity || beside.fontSize !== plain.fontSize) return plain;
  const y = listFirstRowY(plain.rows) - SESSION_MARK.size / 2;
  return drawMark(ctx, SESSION_MARK.x, y, SESSION_MARK.size, canvasModule) ? beside : plain;
}

// An empty grid's message, centered on the key, with the mark level with it where the
// message keeps clear of the mark's column.
function drawListMessage(ctx, message, size, width, canvasModule) {
  const font = fontSpec("bold", size);
  ctx.font = font;
  if (ctx.measureText(message).width <= width - SESSION_CONTENT_X * 2) {
    drawMark(ctx, SESSION_MARK.x, HEIGHT / 2 - SESSION_MARK.size / 2, SESSION_MARK.size, canvasModule);
  }
  drawText(ctx, message, width / 2, 36, {
    font,
    align: "center",
    color: "#d4d4d8",
    maxWidth: width - 20,
  });
}

const AUTOMATION_MAX_ITEMS = 6;
// Between the left column's time label and the right column's status dot (narrower
// on keys too small for two wide columns).
const AUTOMATION_COLUMN_GAP = 14;
const AUTOMATION_NARROW_COLUMN_GAP = 10;
// Two columns only when each holds the dot, a few title characters and a short time
// label ("Tmrw", "10/17"); narrower keys get one column of 3 rows (240px still gets two).
const AUTOMATION_MIN_COLUMN_WIDTH = 100;
// Between a title and its time label.
const AUTOMATION_TIME_GAP = 6;
// Left of the title: the status dot and its margin.
const AUTOMATION_TITLE_INSET = 15;
// Room left for the title in the space after the dot. A time label is shown in full
// while the title keeps this share of the row, else in its short form ("Tmrw" for
// "Tmrw 09:00"); a state label without a short form ("Running") may take more, as long
// as the title keeps the minimum (about 3 CJK characters). Only past that is it cut.
const AUTOMATION_TITLE_SHARE = 0.45;
const AUTOMATION_MIN_TITLE_WIDTH = 36;

// Grid of a scheduled-tasks key: up to 6 tasks filled column-major, 1-3 in the left
// column and 4-6 in the right; two equal columns only when there are more than 3 and
// the key is wide enough. A key too narrow for two columns lists 3 rows, and when the
// tasks do not all fit the last row is "+N" (as on the session overview). Each slot
// gives the dot/title start x, the row's center y and the column's right edge; the
// "+N" row, if any, is the slot after the visible ones. `left` is where the grid
// starts (right of the mark when it has one).
function automationOverviewLayout(width, itemCount, left = OVERVIEW_PADDING) {
  const inner = keyCanvasWidth(width) - left - OVERVIEW_PADDING;
  const count = Math.max(0, Math.min(AUTOMATION_MAX_ITEMS, Math.floor(Number(itemCount) || 0)));
  const wideColumns = (inner - AUTOMATION_COLUMN_GAP) / 2 >= OVERVIEW_WIDE_COLUMN_WIDTH;
  const pairGap = wideColumns ? AUTOMATION_COLUMN_GAP : AUTOMATION_NARROW_COLUMN_GAP;
  const fitsTwoColumns = (inner - pairGap) / 2 >= AUTOMATION_MIN_COLUMN_WIDTH;
  const capacity = fitsTwoColumns ? AUTOMATION_MAX_ITEMS : OVERVIEW_ROWS;
  const visibleCount = count > capacity ? capacity - 1 : count;
  const columns = fitsTwoColumns && count > OVERVIEW_ROWS ? 2 : 1;
  const columnGap = columns > 1 ? pairGap : 0;
  const columnWidth = (inner - columnGap * (columns - 1)) / columns;
  const rows = Math.max(1, Math.min(OVERVIEW_ROWS, count));
  const firstRowY = listFirstRowY(rows);
  const wide = columnWidth >= OVERVIEW_WIDE_COLUMN_WIDTH;
  const slots = Array.from({ length: Math.min(count, capacity) }, (_, index) => {
    const column = Math.floor(index / OVERVIEW_ROWS);
    const row = index % OVERVIEW_ROWS;
    const x = Math.round(left + column * (columnWidth + columnGap));
    return {
      column,
      row,
      x,
      y: firstRowY + row * OVERVIEW_ROW_GAP,
      right: Math.round(left + column * (columnWidth + columnGap) + columnWidth),
    };
  });
  return {
    left,
    columns,
    columnWidth,
    columnGap,
    rows,
    capacity,
    visibleCount,
    hiddenCount: count - visibleCount,
    slots,
    fontSize: wide ? 13 : 12,
    timeFontSize: wide ? 12 : 11,
  };
}

// Scheduled tasks: a status dot, the task name and its next run (or state) per row;
// green = scheduled, blue = running or due, gray = no next run, paused or another state.
function renderAutomationOverviewKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);

    const items = Array.isArray(view && view.items) ? view.items.slice(0, AUTOMATION_MAX_ITEMS) : [];
    if (items.length === 0) {
      const message = t(language, view && view.available === false ? "scheduledTasksUnavailable" : "noScheduledTasks");
      // Shrinks before it cuts: "Scheduled tasks unavailable" is wider than a 240px key at 16px.
      const size = largestFittingFontSize(ctx, message, "bold", 16, 9, width - 20);
      drawListMessage(ctx, message, size, width, canvasModule);
      return;
    }

    const layout = drawListMark(ctx, automationOverviewLayout, width, items.length, canvasModule);
    items.slice(0, layout.visibleCount).forEach((item, index) => {
      drawAutomationRow(ctx, item, layout.slots[index], layout, language);
    });

    if (layout.hiddenCount > 0) {
      // Counts every task not shown, including those past the view's 6. Blue while it
      // hides one that is running or due.
      const hidden = Math.max(items.length, Number(view.total) || 0) - layout.visibleCount;
      const hidesActive = items.slice(layout.visibleCount).some((item) => item.status === "running" || item.status === "due");
      const { x, y, right } = layout.slots[layout.visibleCount];
      drawText(ctx, `+${hidden}`, x + AUTOMATION_TITLE_INSET, automationBaseline(y, layout.fontSize), {
        font: fontSpec("bold", layout.fontSize),
        color: hidesActive ? STATUS_COLORS.blue : "#a1a1aa",
        maxWidth: right - x - AUTOMATION_TITLE_INSET,
      });
    }
  });
}

function automationBaseline(y, size) {
  return y + Math.round(size * 0.35 * 2) / 2;
}

function drawAutomationRow(ctx, item, slot, layout, language) {
  const { x, y, right } = slot;
  const { fontSize, timeFontSize } = layout;
  const dimmed = item.status === "paused" || item.status === "other" || item.status === "unscheduled";
  const titleX = x + AUTOMATION_TITLE_INSET;
  const room = right - titleX;
  drawStatusLight(ctx, x + 5, y, item.statusColor, 4.5);

  const timeFont = fontSpec("normal", timeFontSize);
  const timeRoom = room - AUTOMATION_TIME_GAP;
  ctx.font = timeFont;
  const timeLabel = fitAutomationTimeLabel(
    ctx,
    item,
    timeRoom - Math.max(AUTOMATION_MIN_TITLE_WIDTH, room * AUTOMATION_TITLE_SHARE),
    timeRoom - AUTOMATION_MIN_TITLE_WIDTH
  );
  let timeWidth = 0;
  if (timeLabel) {
    timeWidth = Math.ceil(ctx.measureText(timeLabel).width);
    drawText(ctx, timeLabel, right, automationBaseline(y, timeFontSize), {
      font: timeFont,
      align: "right",
      color: item.status === "due" || item.status === "running" ? STATUS_COLORS.blue : "#d4d4d8",
    });
  }

  drawText(ctx, item.title || t(language, "untitled"), titleX, automationBaseline(y, fontSize), {
    font: fontSpec(dimmed ? "normal" : "bold", fontSize),
    color: dimmed ? "#d4d4d8" : "#ffffff",
    // At least 1: drawText treats a maxWidth of 0 as "no limit".
    maxWidth: Math.max(1, room - timeWidth - (timeLabel ? AUTOMATION_TIME_GAP : 0)),
  });
}

// The full time label if it fits in preferredWidth, else the medium one if the item has
// one ("Running · Tmrw" for "Running · Tmrw 09:00") and it fits there, else the short
// one ("Tmrw" for "Tmrw 09:00", "Running", the same label for other states) if it fits
// in maxWidth, else the short one cut to preferredWidth, so the title keeps its share:
// only another state's long name, or a key far below 240px, gets there. Expects
// ctx.font to be the time font.
function fitAutomationTimeLabel(ctx, item, preferredWidth, maxWidth) {
  const full = String(item.timeLabel || "");
  const medium = String(item.mediumTimeLabel || "");
  const short = String(item.shortTimeLabel || "") || full;
  if (full && ctx.measureText(full).width <= preferredWidth) return full;
  if (medium && ctx.measureText(medium).width <= preferredWidth) return medium;
  if (short && ctx.measureText(short).width <= maxWidth) return short;
  return fitText(ctx, short, Math.max(0, preferredWidth));
}

function renderSkillKey(view, options = {}) {
  const language = normalizeLanguage(options.language);
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);
    drawHeader(ctx, view.skillLabel || t(language, "skillLabel"), width, canvasModule);
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
  return renderKey(options, (ctx, width, canvasModule) => {
    drawBackground(ctx, width);
    const label = view.label || t(language, "newSessionLabel");
    const title = view.title || t(language, "newSessionAction");
    const project = view.project || t(language, "newSessionDefaultProject");

    const textX = newSessionTextX();
    if (width - textX - 8 < NEW_SESSION_MIN_TEXT_WIDTH) {
      drawCompactNewSessionKey(ctx, width, canvasModule, { label, title, project });
      return;
    }

    drawNewSessionIcon(ctx, canvasModule);
    const maxWidth = width - textX - 8;
    drawText(ctx, label, textX, HEADER_LABEL_Y, {
      font: fontSpec("normal", 11),
      color: "#d4d4d8",
      maxWidth,
    });
    drawText(ctx, title, textX, 37, {
      font: fontSpec("bold", 20),
      color: "#ffffff",
      maxWidth,
    });
    drawText(ctx, project, textX, 54, {
      font: fontSpec("normal", 10),
      color: "#d4d4d8",
      maxWidth,
    });
  });
}

// A narrow New Codex Session key: the header mark and label, a green "+" circle left of
// the title, and the project across the whole key.
function drawCompactNewSessionKey(ctx, width, canvasModule, { label, title, project }) {
  drawHeader(ctx, label, width, canvasModule);
  const iconX = 22;
  drawPlusCircle(ctx, iconX, 34);
  const textX = iconX + 18;
  drawText(ctx, title, textX, 40, {
    font: fontSpec("bold", 20),
    color: "#ffffff",
    maxWidth: Math.max(1, width - textX - 8),
  });
  drawText(ctx, project, 10, 56, {
    font: fontSpec("normal", 10),
    color: "#d4d4d8",
    maxWidth: width - 20,
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
  draw(ctx, width, canvasModule);
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
  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, HEIGHT);
}

// The OpenAI mark in the square (x, y, size). True when drawn; a missing Path2D or a
// drawing error only leaves the mark out.
function drawMark(ctx, x, y, size, canvasModule) {
  try {
    return drawOpenAiLogo(ctx, x, y, size, MARK_COLOR, canvasModule) === true;
  } catch {
    return false;
  }
}

// Top-left header: the mark (unless `mark` is false), then the label, which ends before
// `right` (default: the key's right padding) and is at most HEADER_LABEL_MAX_WIDTH wide.
function drawHeader(ctx, label, width, canvasModule, options = {}) {
  const marked = options.mark !== false && drawMark(ctx, HEADER_MARK.x, HEADER_MARK.y, HEADER_MARK.size, canvasModule);
  const x = marked ? HEADER_MARK.x + HEADER_MARK.size + HEADER_MARK.gap : HEADER_MARK.x;
  const right = Number.isFinite(options.right) ? options.right : width - 8;
  drawText(ctx, label, x, HEADER_LABEL_Y, {
    font: fontSpec("normal", 11),
    color: "#d4d4d8",
    // At least 1: drawText treats a maxWidth of 0 as "no limit".
    maxWidth: Math.max(1, Math.min(HEADER_LABEL_MAX_WIDTH, right - x)),
  });
}

// The New Codex Session icon column: the mark with a green "+" badge, or a green "+"
// circle when the mark cannot be drawn.
function drawNewSessionIcon(ctx, canvasModule) {
  const { x, y, size, badgeRadius, badgeRing } = NEW_SESSION_MARK;
  if (!drawMark(ctx, x, y, size, canvasModule)) {
    drawPlusCircle(ctx, x + size / 2, y + size / 2);
    return;
  }

  const [cx, cy] = newSessionBadgeCenter();
  try {
    // A ring in the background color sets the badge off from the mark.
    fillCircle(ctx, cx, cy, badgeRadius + badgeRing, BACKGROUND_COLOR);
    fillCircle(ctx, cx, cy, badgeRadius, ICON_BADGES.newSession.color);
    ctx.save();
    try {
      ICON_BADGES.newSession.draw(ctx, cx, cy, badgeRadius);
    } finally {
      ctx.restore();
    }
  } catch {
    // The mark alone still says whose app the key opens.
  }
}

function newSessionBadgeCenter() {
  const { x, y, size } = NEW_SESSION_MARK;
  return [x + size - 1, y + size - 1];
}

// Where the New Codex Session text starts: right of the badge.
function newSessionTextX() {
  const { badgeRadius, badgeRing, textGap } = NEW_SESSION_MARK;
  return Math.ceil(newSessionBadgeCenter()[0] + badgeRadius + badgeRing) + textGap;
}

// The green "+" circle of New Codex Session without its mark.
function drawPlusCircle(ctx, cx, cy) {
  fillCircle(ctx, cx, cy, 11, ICON_BADGES.newSession.color);
  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(cx - 6, cy - 1.5, 12, 3);
  ctx.fillRect(cx - 1.5, cy - 6, 3, 12);
}

function fillCircle(ctx, cx, cy, radius, color) {
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

// Distance from (px, py) to the nearest point of the square (x, y, size).
function distanceToBox(px, py, x, y, size) {
  const dx = Math.max(x - px, 0, px - (x + size));
  const dy = Math.max(y - py, 0, py - (y + size));
  return Math.hypot(dx, dy);
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

function largestFittingFontSize(ctx, text, weight, maxSize, minSize, maxWidth) {
  for (let size = maxSize; size > minSize; size -= 1) {
    ctx.font = fontSpec(weight, size);
    if (ctx.measureText(String(text || "")).width <= maxWidth) return size;
  }
  return minSize;
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
  HEADER_MARK,
  NEW_SESSION_MARK,
  SESSION_CONTENT_X,
  SESSION_MARK,
  automationOverviewLayout,
  renderAutomationOverviewKey,
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
  // Drawing helpers for key renderers in their own files (dotsRender.js).
  STATUS_COLORS,
  drawBackground,
  drawHeader,
  drawStatusLight,
  drawText,
  renderKey,
};
