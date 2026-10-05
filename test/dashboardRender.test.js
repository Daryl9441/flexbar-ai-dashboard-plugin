"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const canvasModule = require("@napi-rs/canvas");
const { drawOpenAiLogo } = require("../src/dashboard/openaiLogo");
const {
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
} = require("../src/dashboard/render");

const NOW = 1_000_000_000_000;
const RESET_ITEMS = [
  { label: "5h", resetAtMs: NOW + 2 * 3600 * 1000, windowSeconds: 5 * 3600 },
  { label: "Weekly", resetAtMs: NOW + 3 * 86400 * 1000, windowSeconds: 7 * 86400 },
];
const HEADER_LABEL_X = HEADER_MARK.x + HEADER_MARK.size + HEADER_MARK.gap;
const NEW_SESSION_BADGE = {
  cx: NEW_SESSION_MARK.x + NEW_SESSION_MARK.size - 1,
  cy: NEW_SESSION_MARK.y + NEW_SESSION_MARK.size - 1,
};
const NEW_SESSION_TEXT_X =
  Math.ceil(NEW_SESSION_BADGE.cx + NEW_SESSION_MARK.badgeRadius + NEW_SESSION_MARK.badgeRing) + NEW_SESSION_MARK.textGap;
const SESSION_VIEW = {
  title: "A very long session title that needs truncation before the token label",
  tokenLabel: "12.3k",
  statusColor: "blue",
  activity: "Editing: src/plugin.js",
};
const OVERVIEW_VIEW = {
  items: Array.from({ length: 8 }, (_, index) => ({
    title: `Session ${index + 1}`,
    status: index % 2 ? "done" : "running",
    statusColor: index % 2 ? "green" : "blue",
  })),
};
const AUTOMATION_VIEW = {
  available: true,
  total: 6,
  items: Array.from({ length: 6 }, (_, index) => ({
    title: `Task ${index + 1}`,
    timeLabel: "Tmrw 09:00",
    shortTimeLabel: "Tmrw",
    status: "active",
    statusColor: "green",
  })),
};

test("dashboard renderer creates PNG data URLs at dynamic key width and fixed 60px height", () => {
  const fake = createFakeCanvasModule();

  const tokenImage = renderTokenUsageKey({ title: "Tokens", label: "123.4k" }, { width: 320, canvasModule: fake });
  const planImage = renderPlanUsageKey({
    title: "Plan",
    items: [{ label: "5h", remainingPercent: 92, usedPercent: 8 }],
  }, { width: 280, canvasModule: fake });
  const sessionImage = renderSessionKey({
    title: "A very long session title that needs truncation",
    tokenLabel: "12.3k",
    statusColor: "orange",
    activity: "\u7b49\u5f85\u6279\u51c6: npm install",
  }, { width: 520, canvasModule: fake });
  const skillImage = renderSkillKey({
    title: "diagnose",
    activity: "Tap to use skill",
  }, { width: 240, canvasModule: fake });

  assert.equal(tokenImage, "data:image/png;base64,fake");
  assert.equal(planImage, "data:image/png;base64,fake");
  assert.equal(sessionImage, "data:image/png;base64,fake");
  assert.equal(skillImage, "data:image/png;base64,fake");
  assert.deepEqual(fake.sizes, [
    { width: 320, height: 60 },
    { width: 280, height: 60 },
    { width: 520, height: 60 },
    { width: 240, height: 60 },
  ]);
});

test("dashboard renderer requires a canvas module and does not fall back to SVG", () => {
  assert.throws(
    () => renderTokenUsageKey({ title: "Tokens", label: "1k" }, { width: 240, canvasModule: null }),
    /@napi-rs\/canvas/
  );
});

test("plan usage bars change color by remaining quota, not row position", () => {
  const fake = createFakeCanvasModule();

  for (const remainingPercent of [80, 30, 8]) {
    renderPlanUsageKey({
      title: "Plan",
      items: [{ label: "5h", remainingPercent, usedPercent: 100 - remainingPercent }],
    }, { width: 320, canvasModule: fake });
  }

  assert.deepEqual(fake.fills.filter((color) => ["#22c55e", "#f59e0b", "#ef4444"].includes(color)), [
    "#22c55e",
    "#f59e0b",
    "#ef4444",
  ]);
});

test("plan usage percent labels sit outside progress bars", () => {
  const fake = createFakeCanvasModule();

  renderPlanUsageKey({
    title: "Plan",
    items: [{ label: "5h", remainingPercent: 92, usedPercent: 8 }],
  }, { width: 280, canvasModule: fake });

  const percent = fake.textDraws.find((text) => text.text === "92%");
  const bar = fake.roundedRects.find((rect) => rect.color === "#27272a" && rect.y === 25);

  assert.ok(bar);
  assert.ok(percent);
  const percentLeft = percent.x - fake.measureTextWidth(percent.text);
  assert.ok(percentLeft > bar.x + bar.width);
});

test("reset timer renders a depleting ring and compact remaining time per window", () => {
  const fake = createFakeCanvasModule();
  const now = 1_000_000_000_000;

  renderResetTimerKey({
    title: "Reset Timer",
    items: [
      { label: "5h", resetAtMs: now + 2 * 3600 * 1000, windowSeconds: 5 * 3600 },
      { label: "Weekly", resetAtMs: now + 3 * 86400 * 1000, windowSeconds: 7 * 86400 },
    ],
  }, { width: 200, now, canvasModule: fake });

  assert.ok(fake.texts.includes("2h"));
  assert.ok(fake.texts.includes("3d"));
  assert.ok(fake.texts.includes("5h"));
  assert.ok(fake.texts.includes("Weekly"));
  assert.ok(fake.fills.includes("#38bdf8"));
});

test("reset timer empties the ring once the window has passed its reset", () => {
  const fake = createFakeCanvasModule();
  const now = 1_000_000_000_000;

  renderResetTimerKey({
    items: [{ label: "5h", resetAtMs: now - 1000, windowSeconds: 5 * 3600 }],
  }, { width: 200, now, canvasModule: fake });

  assert.ok(fake.texts.includes("<1m"));
  assert.ok(!fake.fills.includes("#38bdf8"));
});

test("reset timer localizes the unavailable state when no windows are known", () => {
  const fake = createFakeCanvasModule();

  renderResetTimerKey({ items: [] }, { width: 200, language: "zh-CN", canvasModule: fake });

  assert.ok(fake.texts.includes("不可用"));
});

test("new session key shows the action and the target project", () => {
  const fake = createFakeCanvasModule();

  const image = renderNewSessionKey({ project: "flexbar-ai-dashboard-plugin" }, { width: 240, canvasModule: fake });

  assert.equal(image, "data:image/png;base64,fake");
  assert.deepEqual(fake.sizes, [{ width: 240, height: 60 }]);
  assert.ok(fake.texts.includes("Codex"));
  assert.ok(fake.texts.includes("New session"));
  assert.ok(fake.texts.some((text) => text.startsWith("flexbar-ai")));
  assert.ok(fake.fills.includes("#22c55e"));
});

test("new session key localizes the default project hint", () => {
  const fake = createFakeCanvasModule();

  renderNewSessionKey({}, { width: 240, language: "zh-CN", canvasModule: fake });

  assert.ok(fake.texts.includes("\u65b0\u4f1a\u8bdd"));
  assert.ok(fake.texts.includes("\u5e94\u7528\u5f53\u524d\u9879\u76ee"));
});

test("plan usage label column widens to fit long labels such as Monthly", () => {
  const narrow = createFakeCanvasModule();
  renderPlanUsageKey({ items: [{ label: "5h", remainingPercent: 60 }] }, { width: 280, canvasModule: narrow });
  const wide = createFakeCanvasModule();
  renderPlanUsageKey({ items: [{ label: "Monthly", remainingPercent: 60 }] }, { width: 280, canvasModule: wide });

  const barX = (fake) => Math.min(...fake.roundedRects.map((rect) => rect.x));
  assert.equal(barX(narrow), 52, "short labels keep the original layout");
  assert.ok(barX(wide) >= 10 + "Monthly".length * 8, "the bar starts after the full label");
  assert.ok(wide.texts.includes("Monthly"), "not truncated");
});

test("reset timer still counts down a window of unknown length, without a progress arc", () => {
  const fake = createFakeCanvasModule();
  const now = 1_000_000_000_000;

  renderResetTimerKey({ items: [{ label: "Usage", resetAtMs: now + 3 * 86400 * 1000, windowSeconds: null }] }, { width: 200, now, canvasModule: fake });

  assert.ok(fake.texts.includes("3d"));
  assert.ok(fake.texts.includes("Usage"));
  assert.ok(!fake.fills.includes("#38bdf8"), "no arc without a window length");
});

test("session key renderer does not draw layout guide borders", () => {
  const fake = createFakeCanvasModule();

  renderSessionKey({
    title: "\u5f00\u53d1 Codex \u7528\u91cf\u63d2\u4ef6",
    tokenLabel: "12.3k",
    statusColor: "blue",
    activity: "\u6b63\u5728\u7f16\u8f91: src/plugin.js",
  }, { width: 520, canvasModule: fake });

  assert.equal(fake.strokeRects, 0);
});

test("session key renderer uses unicode-capable fallback fonts", () => {
  const fake = createFakeCanvasModule();

  renderSessionKey({
    title: "\u5f00\u53d1 Codex \u7528\u91cf\u63d2\u4ef6",
    tokenLabel: "12.3k",
    statusColor: "blue",
    activity: "\u6b63\u5728\u7f16\u8f91: src/plugin.js",
  }, { width: 520, canvasModule: fake });

  assert.ok(fake.fonts.some((font) => font.includes("Microsoft YaHei") || font.includes("PingFang SC") || font.includes("Noto Sans CJK")));
  if (process.platform === "win32") {
    assert.ok(fake.fonts.every((font) => font.indexOf("Microsoft YaHei") < font.indexOf("Segoe UI")));
  }
});

test("dashboard renderer localizes fallback labels", () => {
  const fake = createFakeCanvasModule();

  renderTokenUsageKey({}, { width: 240, language: "zh-CN", canvasModule: fake });
  renderPlanUsageKey({ items: [] }, { width: 240, language: "zh-CN", canvasModule: fake });
  renderSessionKey({}, { width: 240, language: "zh-CN", canvasModule: fake });
  renderSkillKey({}, { width: 240, language: "zh-CN", canvasModule: fake });

  assert.ok(fake.texts.includes("\u4ee4\u724c\u7528\u91cf"));
  assert.ok(fake.texts.includes("\u4e0d\u53ef\u7528"));
  assert.ok(fake.texts.includes("\u672a\u547d\u540d"));
  assert.ok(fake.texts.includes("\u6280\u80fd"), "the skill label names no data source");
  assert.ok(fake.texts.includes("\u9009\u62e9\u6280\u80fd"));
  assert.ok(fake.texts.includes("\u8f7b\u70b9\u4f7f\u7528\u6280\u80fd"));
});

test("token usage renderer draws recent chart bars", () => {
  const fake = createFakeCanvasModule();

  renderTokenUsageKey({
    mode: "recentChart",
    title: "Token Usage",
    label: "850",
    recentLabel: "Recent usage",
    recent: [
      { value: 100, intensity: 20 },
      { value: 500, intensity: 100 },
      { value: 250, intensity: 50 },
    ],
  }, { width: 240, canvasModule: fake });

  assert.ok(fake.texts.includes("Recent usage"));
  assert.ok(fake.fills.includes("#22c55e"));
  assert.ok(fake.fills.includes("#f59e0b"));

  const bars = fake.roundedRects.filter((rect) => ["#22c55e", "#f59e0b", "#ef4444"].includes(rect.color));
  const valueLabels = ["100", "500", "250"].map((value) => fake.textDraws.find((text) => text.text === value));

  assert.equal(bars.length, 3);
  for (const [index, label] of valueLabels.entries()) {
    assert.ok(label);
    assert.equal(label.align, "center");
    assert.equal(label.x, bars[index].x + bars[index].width / 2);
    assert.ok(label.y > bars[index].y + bars[index].height);
  }
});

test("token usage renderer draws recent chart labels as bottom integers", () => {
  const fake = createFakeCanvasModule();

  renderTokenUsageKey({
    mode: "recentChart",
    recent: [
      { value: 1250, intensity: 100 },
    ],
  }, { width: 240, canvasModule: fake });

  const bar = fake.roundedRects.find((rect) => rect.color === "#ef4444");
  const label = fake.textDraws.find((text) => text.text === "1k");

  assert.ok(bar);
  assert.ok(label);
  assert.equal(label.align, "center");
  assert.ok(label.y > bar.y + bar.height);
  assert.equal(fake.texts.includes("1.3k"), false);
});

test("token usage renderer localizes empty recent chart state", () => {
  const fake = createFakeCanvasModule();

  renderTokenUsageKey({
    mode: "recentChart",
    recent: [],
  }, { width: 240, language: "zh-CN", canvasModule: fake });

  assert.ok(fake.texts.includes("\u6682\u65e0\u8fd1\u671f\u7528\u91cf"));
});

test("keys with a header label draw the OpenAI mark left of it and move the label right", () => {
  const cases = [
    ["token summary", (options) => renderTokenUsageKey({ title: "Tokens", label: "1k" }, options), "Tokens"],
    ["token chart", (options) => renderTokenUsageKey({
      mode: "recentChart",
      recentLabel: "Recent usage",
      label: "850",
      recent: [{ value: 850, intensity: 40 }],
    }, options), "Recent usage"],
    ["plan usage", (options) => renderPlanUsageKey({ title: "Plan", items: [{ label: "5h", remainingPercent: 60 }] }, options), "Plan"],
    ["skill", (options) => renderSkillKey({ title: "diagnose" }, options), "Skill"],
  ];
  for (const [name, render, label] of cases) {
    const fake = createFakeCanvasModule({ path2d: true });
    assert.equal(render({ width: 240, canvasModule: fake }), "data:image/png;base64,fake", name);
    assert.deepEqual(fake.logoDraws, [{ x: HEADER_MARK.x, y: HEADER_MARK.y, size: HEADER_MARK.size, color: "#ffffff" }], name);
    const header = fake.textDraws.find((draw) => draw.text === label);
    assert.ok(header, name);
    assert.equal(header.x, HEADER_LABEL_X, name);
    // The label's baseline sits in the mark's box, so the two read as one line.
    assert.ok(header.y > HEADER_MARK.y && header.y <= HEADER_MARK.y + HEADER_MARK.size, name);

    // Without Path2D there is no mark and the label keeps its old place.
    const plain = createFakeCanvasModule();
    render({ width: 240, canvasModule: plain });
    assert.deepEqual(plain.logoDraws, [], name);
    assert.equal(plain.textDraws.find((draw) => draw.text === label).x, HEADER_MARK.x, name);
  }
});

test("token usage leaves the header mark out where the big total would reach under it", () => {
  // Fake text is 8px a character: "123.4k" starts at 96 on a 240px key, clear of the mark.
  const wide = createFakeCanvasModule({ path2d: true });
  renderTokenUsageKey({ title: "Tokens", label: "123.4k" }, { width: 240, canvasModule: wide });
  assert.equal(wide.logoDraws.length, 1);
  assert.equal(wide.textDraws.find((draw) => draw.text === "Tokens").x, HEADER_LABEL_X);

  // An 88px total on a 120px key starts at 16, under the mark (which ends at 22).
  const narrow = createFakeCanvasModule({ path2d: true });
  renderTokenUsageKey({ title: "Tokens", label: "123,456,789" }, { width: 120, canvasModule: narrow });
  assert.deepEqual(narrow.logoDraws, []);
  assert.equal(narrow.textDraws.find((draw) => draw.text === "Tokens").x, HEADER_MARK.x);
  assert.equal(narrow.textDraws.find((draw) => draw.text === "123,456,789").x, 60);
});

test("header labels end before the key edge and before the token chart total", () => {
  const narrow = createFakeCanvasModule({ path2d: true });
  renderPlanUsageKey({ title: "A plan usage title far too long for the key", items: [] }, { width: 120, canvasModule: narrow });
  const plan = narrow.textDraws.find((draw) => draw.text.startsWith("A plan"));
  assert.ok(plan.text.endsWith("..."));
  assert.ok(plan.x + narrow.measureTextWidth(plan.text) <= 120 - 8);

  const chart = createFakeCanvasModule({ path2d: true });
  renderTokenUsageKey({
    mode: "recentChart",
    recentLabel: "Recent usage over the last hours",
    label: "12.3k",
    recent: [{ value: 1, intensity: 10 }],
  }, { width: 200, canvasModule: chart });
  const header = chart.textDraws.find((draw) => draw.text.startsWith("Recent"));
  const total = chart.textDraws.find((draw) => draw.text === "12.3k");
  assert.equal(total.align, "right");
  assert.equal(total.x, 200 - 8);
  assert.ok(header.text.endsWith("..."));
  assert.ok(header.x + chart.measureTextWidth(header.text) <= total.x - chart.measureTextWidth(total.text) - 8);
});

test("session key draws a 16px mark left of the title and narrows the title, not the token label", () => {
  const fake = createFakeCanvasModule({ path2d: true });
  renderSessionKey(SESSION_VIEW, { width: 520, canvasModule: fake });
  const plain = createFakeCanvasModule();
  renderSessionKey(SESSION_VIEW, { width: 520, canvasModule: plain });

  assert.deepEqual(fake.logoDraws, [{ x: SESSION_MARK.x, y: SESSION_MARK.y, size: 16, color: "#ffffff" }]);
  const title = fake.textDraws.find((draw) => draw.text.startsWith("A very"));
  const plainTitle = plain.textDraws.find((draw) => draw.text.startsWith("A very"));
  assert.equal(title.x, SESSION_CONTENT_X);
  assert.equal(plainTitle.x, 8);
  assert.ok(title.text.length < plainTitle.text.length, "the title is cut earlier");

  // The token label, status light and activity line keep their places.
  const token = (module) => module.textDraws.find((draw) => draw.text === "12.3k");
  assert.deepEqual(token(fake), token(plain));
  assert.ok(title.x + fake.measureTextWidth(title.text) <= token(fake).x - fake.measureTextWidth("12.3k"));
  assert.deepEqual(fake.arcs, plain.arcs);
  const activity = (module) => module.textDraws.find((draw) => draw.text === SESSION_VIEW.activity);
  assert.deepEqual(activity(fake), activity(plain));

  // At 240px the title keeps 112px beside the mark. Under about 218px it would keep less
  // than 90px (2-3 words), so there is no mark and the title has the room.
  const medium = createFakeCanvasModule({ path2d: true });
  renderSessionKey(SESSION_VIEW, { width: 240, canvasModule: medium });
  assert.equal(medium.logoDraws.length, 1);
  for (const width of [216, 200, 160]) {
    const narrow = createFakeCanvasModule({ path2d: true });
    renderSessionKey(SESSION_VIEW, { width, canvasModule: narrow });
    assert.deepEqual(narrow.logoDraws, [], `${width}px`);
    assert.equal(narrow.textDraws.find((draw) => draw.text.startsWith("A ")).x, 8, `${width}px`);
  }
  const edge = createFakeCanvasModule({ path2d: true });
  renderSessionKey(SESSION_VIEW, { width: 218, canvasModule: edge });
  assert.equal(edge.logoDraws.length, 1);
  const edgeTitle = edge.textDraws.find((draw) => draw.text.startsWith("A "));
  assert.ok(edge.measureTextWidth(edgeTitle.text) > 80, "the title keeps most of its 90px");
});

test("reset timer draws the header mark clear of the rings at 150 to 240px, and none where it would touch one", () => {
  // The same spot and size as on the keys with a header label, so the marks line up on a strip.
  const markBox = { x: HEADER_MARK.x, y: HEADER_MARK.y, size: HEADER_MARK.size };
  for (const width of [150, 200, 240]) {
    for (const count of [1, 2]) {
      const fake = createFakeCanvasModule({ path2d: true });
      renderResetTimerKey({ items: RESET_ITEMS.slice(0, count) }, { width, now: NOW, canvasModule: fake });
      assert.deepEqual(fake.logoDraws, [{ ...markBox, color: "#ffffff" }], `${width}px, ${count} window(s)`);
      const rings = fake.arcs.filter((arc) => arc.radius === 16);
      assert.ok(rings.length >= count);
      for (const ring of rings) {
        assert.ok(distanceToBox(ring, markBox) >= ring.radius + 2, `${width}px: the mark keeps clear of the ring at ${ring.x}`);
      }
      // Window labels and remaining times stay below or right of the mark.
      for (const draw of fake.textDraws) {
        const left = draw.align === "center" ? draw.x - fake.measureTextWidth(draw.text) / 2 : draw.x;
        assert.ok(draw.y - 10 > markBox.y + markBox.size || left > markBox.x + markBox.size, draw.text);
      }
    }
  }

  const narrow = createFakeCanvasModule({ path2d: true });
  renderResetTimerKey({ items: RESET_ITEMS }, { width: 120, now: NOW, canvasModule: narrow });
  assert.deepEqual(narrow.logoDraws, [], "a 120px key has no room for the mark");
  assert.ok(narrow.texts.includes("2h"));

  const unavailable = createFakeCanvasModule({ path2d: true });
  renderResetTimerKey({ items: [] }, { width: 200, canvasModule: unavailable });
  assert.deepEqual(unavailable.logoDraws, [{ ...markBox, color: "#ffffff" }]);
});

test("new session key shows the OpenAI mark with a green plus badge left of its three lines", () => {
  const fake = createFakeCanvasModule({ path2d: true });
  renderNewSessionKey({ project: "example-project" }, { width: 240, canvasModule: fake });

  assert.deepEqual(fake.logoDraws, [{
    x: NEW_SESSION_MARK.x,
    y: NEW_SESSION_MARK.y,
    size: NEW_SESSION_MARK.size,
    color: "#ffffff",
  }]);
  // The badge: a ring in the key background, the green disc, then the "+" stroked on it.
  const badgeArcs = fake.arcs.filter((arc) => arc.x === NEW_SESSION_BADGE.cx && arc.y === NEW_SESSION_BADGE.cy);
  assert.deepEqual(badgeArcs.map((arc) => [arc.radius, arc.color]), [
    [NEW_SESSION_MARK.badgeRadius + NEW_SESSION_MARK.badgeRing, "#050505"],
    [NEW_SESSION_MARK.badgeRadius, "#22c55e"],
  ]);
  assert.equal(fake.strokes, 1);
  // One mark only: the "Codex" header has none of its own.
  for (const text of ["Codex", "New session", "example-project"]) {
    assert.equal(fake.textDraws.find((draw) => draw.text === text).x, NEW_SESSION_TEXT_X, text);
  }

  // Without Path2D: the green "+" circle in the same column, the text where it was.
  const plain = createFakeCanvasModule();
  renderNewSessionKey({ project: "example-project" }, { width: 240, canvasModule: plain });
  assert.deepEqual(plain.logoDraws, []);
  assert.ok(plain.arcs.some((arc) => arc.color === "#22c55e" && arc.radius === 11));
  assert.equal(plain.textDraws.find((draw) => draw.text === "New session").x, NEW_SESSION_TEXT_X);
});

test("a narrow new session key keeps its compact layout, with the header mark", () => {
  // From 137px the text keeps at least 80px beside the badged mark.
  const wide = createFakeCanvasModule({ path2d: true });
  renderNewSessionKey({ project: "example-project" }, { width: 137, canvasModule: wide });
  assert.equal(wide.logoDraws[0].size, NEW_SESSION_MARK.size);

  const fake = createFakeCanvasModule({ path2d: true });
  renderNewSessionKey({ project: "example-app" }, { width: 136, canvasModule: fake });
  assert.deepEqual(fake.logoDraws, [{ x: HEADER_MARK.x, y: HEADER_MARK.y, size: HEADER_MARK.size, color: "#ffffff" }]);
  const at = (text) => fake.textDraws.find((draw) => draw.text.startsWith(text));
  assert.equal(at("Codex").x, HEADER_LABEL_X);
  assert.ok(fake.arcs.some((arc) => arc.x === 22 && arc.y === 34 && arc.radius === 11 && arc.color === "#22c55e"));
  assert.equal(at("New").x, 40);
  // The project runs under the circle, across the key: its 88px fit, where beside the mark only 79px would.
  assert.equal(at("example").x, 10);
  assert.equal(at("example").text, "example-app");
});

test("the all-sessions and scheduled-tasks grids lead with the mark only where it costs them no slot", () => {
  const cases = [
    ["overview", renderSessionOverviewKey, OVERVIEW_VIEW, sessionOverviewLayout, "Session 1"],
    ["scheduled tasks", renderAutomationOverviewKey, AUTOMATION_VIEW, automationOverviewLayout, "Task 1"],
  ];
  for (const [name, render, view, layoutFor, firstTitle] of cases) {
    // 520px (the default): the grid keeps its slots and font size right of a mark column.
    const plainLayout = layoutFor(520, view.items.length);
    const besideLayout = layoutFor(520, view.items.length, SESSION_CONTENT_X);
    assert.deepEqual(
      [besideLayout.capacity, besideLayout.columns, besideLayout.fontSize],
      [plainLayout.capacity, plainLayout.columns, plainLayout.fontSize],
      name
    );
    const fake = createFakeCanvasModule({ path2d: true });
    render(view, { width: 520, canvasModule: fake });
    const plain = createFakeCanvasModule();
    render(view, { width: 520, canvasModule: plain });
    // Level with the first of three rows (centered on y 12), left of the grid.
    assert.deepEqual(fake.logoDraws, [{ x: SESSION_MARK.x, y: 12 - 8, size: 16, color: "#ffffff" }], name);
    assert.deepEqual(fake.texts, plain.texts, `${name}: the same rows`);
    const title = (module) => module.textDraws.find((draw) => draw.text === firstTitle);
    assert.equal(title(fake).x - title(plain).x, SESSION_CONTENT_X - 8, `${name}: the grid starts where the session title does`);
    assert.equal(title(fake).y, title(plain).y);
    const firstDot = fake.arcs.find((arc) => arc.radius === 4.5);
    assert.ok(firstDot.x - firstDot.radius >= SESSION_MARK.x + SESSION_MARK.size + 6, `${name}: the dots keep clear of the mark`);

    // 240px: a mark column would cost the grid slots, so there is none and nothing moves.
    const narrow = createFakeCanvasModule({ path2d: true });
    render(view, { width: 240, canvasModule: narrow });
    const narrowPlain = createFakeCanvasModule();
    render(view, { width: 240, canvasModule: narrowPlain });
    assert.deepEqual(narrow.logoDraws, [], `${name} at 240px`);
    assert.deepEqual(narrow.textDraws, narrowPlain.textDraws, `${name} at 240px`);
  }

  // A single row: the mark is level with it, at the key's middle.
  const one = createFakeCanvasModule({ path2d: true });
  renderSessionOverviewKey({ items: OVERVIEW_VIEW.items.slice(0, 1) }, { width: 520, canvasModule: one });
  assert.deepEqual(one.logoDraws, [{ x: SESSION_MARK.x, y: 22, size: 16, color: "#ffffff" }]);
});

test("empty all-sessions and scheduled-tasks views put the mark level with the message where it keeps clear", () => {
  const empty = createFakeCanvasModule({ path2d: true });
  renderSessionOverviewKey({ items: [] }, { width: 240, canvasModule: empty });
  assert.deepEqual(empty.logoDraws, [{ x: SESSION_MARK.x, y: 22, size: 16, color: "#ffffff" }]);
  // The message stays centered on the key, starting right of the mark's column.
  const message = empty.textDraws.find((draw) => draw.text === "No active sessions");
  assert.deepEqual([message.x, message.align], [120, "center"]);
  assert.ok(message.x - empty.measureTextWidth(message.text) / 2 >= SESSION_CONTENT_X);

  const noTasks = createFakeCanvasModule({ path2d: true });
  renderAutomationOverviewKey({ available: true, items: [] }, { width: 520, canvasModule: noTasks });
  assert.deepEqual(noTasks.logoDraws, [{ x: SESSION_MARK.x, y: 22, size: 16, color: "#ffffff" }]);

  // 216px of message on a 240px key would reach the mark: none.
  const unavailable = createFakeCanvasModule({ path2d: true });
  renderAutomationOverviewKey({ available: false, items: [] }, { width: 240, canvasModule: unavailable });
  assert.deepEqual(unavailable.logoDraws, []);
  assert.ok(unavailable.texts.includes("Scheduled tasks unavailable"));
});

test("a failing mark leaves every key drawn, with labels in their old places", () => {
  const fake = createFakeCanvasModule({ failLogo: true });
  const options = { width: 240, now: NOW, canvasModule: fake };
  const images = [
    renderTokenUsageKey({ title: "Tokens", label: "1k" }, options),
    renderPlanUsageKey({ title: "Plan", items: [] }, options),
    renderResetTimerKey({ items: RESET_ITEMS }, options),
    renderSessionKey(SESSION_VIEW, options),
    renderNewSessionKey({}, options),
    renderSkillKey({}, options),
  ];
  assert.ok(images.every((image) => image === "data:image/png;base64,fake"));
  assert.deepEqual(fake.logoDraws, []);
  assert.equal(fake.textDraws.find((draw) => draw.text === "Tokens").x, HEADER_MARK.x);
  assert.equal(fake.textDraws.find((draw) => draw.text.startsWith("A very")).x, 8);
  assert.ok(fake.arcs.some((arc) => arc.color === "#22c55e" && arc.radius === 11), "new session falls back to the green circle");
});

test("real canvas: the mark's pixels are drawn on every Codex key and nothing else touches them", async () => {
  // [name, image, mark box, region compared with a lone mark on the key background]
  const sessionImage = renderSessionKey(SESSION_VIEW, { width: 520, canvasModule });
  const cases = [
    ["token", renderTokenUsageKey({ label: "123.4k" }, { width: 240, canvasModule }), HEADER_MARK, 2],
    ["token chart", renderTokenUsageKey({ mode: "recentChart", label: "850", recent: [{ value: 850, intensity: 90 }] }, { width: 240, canvasModule }), HEADER_MARK, 2],
    ["plan", renderPlanUsageKey({ items: [{ label: "5h", remainingPercent: 60 }] }, { width: 280, canvasModule }), HEADER_MARK, 2],
    ["skill", renderSkillKey({}, { width: 240, canvasModule }), HEADER_MARK, 2],
    ["session", sessionImage, SESSION_MARK, 2],
    ["reset 200", renderResetTimerKey({ items: RESET_ITEMS }, { width: 200, now: NOW, canvasModule }), HEADER_MARK, 2],
    ["reset 240", renderResetTimerKey({ items: RESET_ITEMS }, { width: 240, now: NOW, canvasModule }), HEADER_MARK, 2],
    ["overview 520", renderSessionOverviewKey(OVERVIEW_VIEW, { width: 520, canvasModule }), { x: SESSION_MARK.x, y: 4, size: 16 }, 2],
    ["scheduled tasks 520", renderAutomationOverviewKey(AUTOMATION_VIEW, { width: 520, canvasModule }), { x: SESSION_MARK.x, y: 4, size: 16 }, 2],
    ["no sessions 240", renderSessionOverviewKey({ items: [] }, { width: 240, canvasModule }), { x: SESSION_MARK.x, y: 22, size: 16 }, 2],
  ];
  for (const [name, image, mark, margin] of cases) {
    const key = await decode(image);
    const expected = loneMark(key.width, mark);
    const region = { x0: mark.x - margin, y0: mark.y - margin, x1: mark.x + mark.size + margin, y1: mark.y + mark.size + margin };
    assert.deepEqual(diffRegion(key, expected, region), [], `${name}: the mark and a ${margin}px margin match a lone mark`);
    assert.ok(countBright(key, region) >= mark.size * 2, `${name}: the mark is drawn in white`);
  }

  // New session: the part of the mark left of / above the badge, and the badge's green.
  const newSession = await decode(renderNewSessionKey({}, { width: 240, canvasModule }));
  const expected = loneMark(240, NEW_SESSION_MARK);
  const region = {
    x0: NEW_SESSION_MARK.x - 2,
    y0: NEW_SESSION_MARK.y - 2,
    x1: Math.floor(NEW_SESSION_BADGE.cx - NEW_SESSION_MARK.badgeRadius - NEW_SESSION_MARK.badgeRing),
    y1: Math.floor(NEW_SESSION_BADGE.cy - NEW_SESSION_MARK.badgeRadius - NEW_SESSION_MARK.badgeRing),
  };
  assert.deepEqual(diffRegion(newSession, expected, region), []);
  assert.ok(countBright(newSession, region) > 20);
  // On the badge, diagonally off the "+" arms.
  assert.deepEqual(pixelAt(newSession, NEW_SESSION_BADGE.cx + 4, NEW_SESSION_BADGE.cy - 4), [0x22, 0xc5, 0x5e, 255]);
});

function distanceToBox(point, box) {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.size));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.size));
  return Math.hypot(dx, dy);
}

async function decode(dataUri) {
  const image = await canvasModule.loadImage(Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64"));
  const canvas = canvasModule.createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return { width: image.width, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

// The key background with only the white mark in the given box.
function loneMark(width, mark) {
  const canvas = canvasModule.createCanvas(width, 60);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, width, 60);
  assert.equal(drawOpenAiLogo(ctx, mark.x, mark.y, mark.size, "#ffffff", canvasModule), true);
  return { width, data: ctx.getImageData(0, 0, width, 60).data };
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
}

function diffRegion(actual, expected, { x0, y0, x1, y1 }) {
  const diffs = [];
  for (let y = Math.max(0, y0); y < Math.min(60, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(actual.width, x1); x += 1) {
      const a = pixelAt(actual, x, y);
      const e = pixelAt(expected, x, y);
      if (a.some((value, index) => Math.abs(value - e[index]) > 2)) diffs.push({ x, y, actual: a, expected: e });
    }
  }
  return diffs.slice(0, 5);
}

// Light gray to white pixels: the antialiased strokes of a white mark 11-16px wide.
function countBright(image, { x0, y0, x1, y1 }) {
  let count = 0;
  for (let y = Math.max(0, y0); y < Math.min(60, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(image.width, x1); x += 1) {
      const [r, g, b] = pixelAt(image, x, y);
      if (r >= 160 && r === g && g === b) count += 1;
    }
  }
  return count;
}

// A canvas module that records what is drawn. With { path2d: true } it has a Path2D, so
// the OpenAI mark is drawn and recorded in logoDraws as its box; with { failLogo: true }
// filling that path throws.
function createFakeCanvasModule(options = {}) {
  const module = {
    sizes: [],
    fills: [],
    fonts: [],
    texts: [],
    textDraws: [],
    roundedRects: [],
    arcs: [],
    logoDraws: [],
    strokes: 0,
    strokeRects: 0,
    measureTextWidth(text) {
      return String(text).length * 8;
    },
  };
  if (options.path2d || options.failLogo) {
    module.Path2D = class FakePath2D {
      constructor(d) {
        this.d = d;
      }
    };
  }
  const contextPrototype = {
    _fillStyle: "",
    _font: "",
    strokeStyle: "",
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    _pathBounds: null,
    beginPath() {
      this._pathBounds = null;
    },
    arc(x, y, radius) {
      module.arcs.push({ x, y, radius, color: this.fillStyle });
    },
    translate(x, y) {
      this._transform.x += x * this._transform.scale;
      this._transform.y += y * this._transform.scale;
    },
    scale(x) {
      this._transform.scale *= x;
    },
    stroke() {
      module.strokes += 1;
    },
    fill(path) {
      if (module.Path2D && path instanceof module.Path2D) {
        if (options.failLogo) throw new Error("fill failed");
        const { x, y, scale } = this._transform;
        // The logo path's viewBox is 24 units.
        module.logoDraws.push({ x, y, size: 24 * scale, color: this.fillStyle });
        return;
      }
      module.fills.push(this.fillStyle);
      if (this._pathBounds) {
        module.roundedRects.push({
          ...this._pathBounds,
          color: this.fillStyle,
        });
      }
    },
    fillRect() {
      module.fills.push(this.fillStyle);
    },
    strokeRect() {
      module.strokeRects += 1;
    },
    moveTo(x, y) {
      this._recordPoint(x, y);
    },
    lineTo(x, y) {
      this._recordPoint(x, y);
    },
    quadraticCurveTo(cx, cy, x, y) {
      this._recordPoint(cx, cy);
      this._recordPoint(x, y);
    },
    _recordPoint(x, y) {
      if (!this._pathBounds) {
        this._pathBounds = { x, y, width: 0, height: 0 };
        return;
      }
      const minX = Math.min(this._pathBounds.x, x);
      const minY = Math.min(this._pathBounds.y, y);
      const maxX = Math.max(this._pathBounds.x + this._pathBounds.width, x);
      const maxY = Math.max(this._pathBounds.y + this._pathBounds.height, y);
      this._pathBounds = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    },
    closePath() {},
    clip() {},
    save() {
      this._saved.push({ ...this._transform });
    },
    restore() {
      this._transform = this._saved.pop() || { x: 0, y: 0, scale: 1 };
    },
    fillText(text, x, y) {
      module.texts.push(String(text));
      module.textDraws.push({
        text: String(text),
        x,
        y,
        align: this.textAlign,
      });
    },
    measureText(text) {
      return { width: module.measureTextWidth(text) };
    },
  };
  Object.defineProperty(contextPrototype, "fillStyle", {
    get() {
      return this._fillStyle;
    },
    set(value) {
      this._fillStyle = value;
    },
  });
  Object.defineProperty(contextPrototype, "font", {
    get() {
      return this._font;
    },
    set(value) {
      this._font = value;
      module.fonts.push(value);
    },
  });
  module.createCanvas = function createCanvas(width, height) {
    module.sizes.push({ width, height });
    return {
      getContext() {
        const ctx = Object.create(contextPrototype);
        ctx._transform = { x: 0, y: 0, scale: 1 };
        ctx._saved = [];
        return ctx;
      },
      toDataURL(type) {
        assert.equal(type, "image/png");
        return "data:image/png;base64,fake";
      },
    };
  };
  return module;
}
