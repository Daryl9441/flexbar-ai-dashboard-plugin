#!/usr/bin/env node
"use strict";

// Renders the key-library icons (the OpenAI mark on a dark tile, with a badge per key type; see
// src/dashboard/openaiLogo.js) as PNG data URIs for manifest.json.
//
// Usage: node scripts/generate-icons.cjs [--write] [--manifest <path>] [--size <px>]
//   (no flag)          prints every icon target with its size and byte counts, and whether the manifest is current
//   --write            replaces keyLibrary.style.icon and each child's style.icon (matched by cid) in place
//   --manifest <path>  manifest to read / update (default com.aspen.flexbar-ai-dashboard.plugin/manifest.json)
//   --size <px>        icon size in pixels (default 96: crisp in the key library on high-DPI screens)
// Only the icon string values change: the rest of the file, its indentation and its \u escapes stay byte-identical.
// Exit code: 0 done, 1 manifest error, 2 usage error.

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const { ICON_SPECS, renderOpenAiIcon } = require("../src/dashboard/openaiLogo");
const { scanLine } = require("./check-privacy.cjs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(ROOT, "com.aspen.flexbar-ai-dashboard.plugin", "manifest.json");
const DEFAULT_SIZE = 96;
const KEY_LIBRARY_TARGET = "keyLibrary";

function parseArgs(argv) {
  const options = { write: false, manifest: DEFAULT_MANIFEST, size: DEFAULT_SIZE, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--manifest" || arg === "--size") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      index += 1;
      if (arg === "--manifest") options.manifest = path.resolve(value);
      else options.size = Number(value);
    } else {
      throw new UsageError(`Unknown argument "${arg}"`);
    }
  }
  if (!Number.isInteger(options.size) || options.size < 16 || options.size > 1024) {
    throw new UsageError("--size must be an integer from 16 to 1024");
  }
  return options;
}

class UsageError extends Error {}

/** Every manifest icon target with its badge and its JSON path: [{ target, badge, jsonPath }]. */
function iconTargets(manifest) {
  const keyLibrary = manifest && manifest.keyLibrary;
  if (!keyLibrary || typeof keyLibrary !== "object") throw new Error("manifest.json has no keyLibrary");
  const children = Array.isArray(keyLibrary.children) ? keyLibrary.children : [];

  return Object.entries(ICON_SPECS).map(([target, badge]) => {
    let jsonPath;
    if (target === KEY_LIBRARY_TARGET) {
      jsonPath = ["keyLibrary", "style", "icon"];
    } else {
      const index = children.findIndex((child) => child && child.cid === target);
      if (index < 0) throw new Error(`manifest.json has no keyLibrary child with cid "${target}"`);
      jsonPath = ["keyLibrary", "children", index, "style", "icon"];
    }
    if (typeof getPath(manifest, jsonPath) !== "string") {
      throw new Error(`manifest.json has no string at ${formatPath(jsonPath)} (${target})`);
    }
    return { target, badge, jsonPath };
  });
}

/** keyLibrary children whose cid has no entry in ICON_SPECS: their icons are left as they are. */
function unknownChildren(manifest) {
  const children = manifest && manifest.keyLibrary && Array.isArray(manifest.keyLibrary.children)
    ? manifest.keyLibrary.children
    : [];
  return children.map((child) => child && child.cid).filter((cid) => !Object.prototype.hasOwnProperty.call(ICON_SPECS, cid));
}

function renderIcons(targets, { size = DEFAULT_SIZE, canvasModule } = {}) {
  return targets.map((entry) => {
    const dataUri = renderOpenAiIcon({ size, badge: entry.badge, canvasModule });
    const pngBytes = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64").length;
    return { ...entry, size, dataUri, pngBytes };
  });
}

/**
 * Replaces the icon string values of `icons` ([{ jsonPath, dataUri }]) in the manifest text without re-serializing
 * it, so every other byte of the file is kept. Returns { text, changed: [jsonPath...] }.
 */
function replaceIcons(text, icons) {
  const spans = jsonValueSpans(text);
  const edits = icons.map((icon) => {
    const span = spans.get(pathKey(icon.jsonPath));
    if (!span || text[span.start] !== "\"") throw new Error(`No string value at ${formatPath(icon.jsonPath)}`);
    return { ...span, value: JSON.stringify(icon.dataUri), jsonPath: icon.jsonPath };
  }).sort((a, b) => b.start - a.start);

  let result = text;
  const changed = [];
  for (const edit of edits) {
    if (result.slice(edit.start, edit.end) === edit.value) continue;
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
    changed.unshift(edit.jsonPath);
  }

  // The new text must parse to the old manifest with only the icons swapped.
  const expected = JSON.parse(text);
  for (const icon of icons) setPath(expected, icon.jsonPath, icon.dataUri);
  if (!isDeepStrictEqual(JSON.parse(result), expected)) {
    throw new Error("Replacing the icons would change more than the icon values");
  }
  return { text: result, changed };
}

/**
 * Start/end offsets of every value in a JSON text, keyed by pathKey(jsonPath). A later duplicate key wins, as in
 * JSON.parse.
 */
function jsonValueSpans(text) {
  const spans = new Map();
  let i = 0;

  const fail = (message) => {
    throw new SyntaxError(`${message} at offset ${i}`);
  };
  const skipSpace = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i += 1;
  };
  const expect = (char) => {
    if (text[i] !== char) fail(`Expected "${char}"`);
    i += 1;
  };
  const readString = () => {
    const start = i;
    expect("\"");
    while (i < text.length && text[i] !== "\"") i += text[i] === "\\" ? 2 : 1;
    expect("\"");
    return JSON.parse(text.slice(start, i));
  };
  const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

  const readValue = (jsonPath) => {
    skipSpace();
    const start = i;
    const char = text[i];
    if (char === "{") {
      i += 1;
      skipSpace();
      if (text[i] === "}") i += 1;
      else {
        for (;;) {
          skipSpace();
          const key = readString();
          skipSpace();
          expect(":");
          readValue([...jsonPath, key]);
          skipSpace();
          if (text[i] === ",") i += 1;
          else {
            expect("}");
            break;
          }
        }
      }
    } else if (char === "[") {
      i += 1;
      skipSpace();
      if (text[i] === "]") i += 1;
      else {
        for (let index = 0; ; index += 1) {
          readValue([...jsonPath, index]);
          skipSpace();
          if (text[i] === ",") i += 1;
          else {
            expect("]");
            break;
          }
        }
      }
    } else if (char === "\"") {
      readString();
    } else {
      LITERAL.lastIndex = i;
      const match = LITERAL.exec(text);
      if (!match) fail("Unexpected token");
      i += match[0].length;
    }
    spans.set(pathKey(jsonPath), { start, end: i });
  };

  if (text.charCodeAt(0) === 0xfeff) i = 1;
  readValue([]);
  skipSpace();
  if (i !== text.length) fail("Unexpected data after the JSON value");
  return spans;
}

function pathKey(jsonPath) {
  return JSON.stringify(jsonPath.map((part) => (typeof part === "number" ? part : String(part))));
}

function formatPath(jsonPath) {
  return jsonPath.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join("").slice(1);
}

function getPath(value, jsonPath) {
  return jsonPath.reduce((node, part) => (node == null ? undefined : node[part]), value);
}

function setPath(value, jsonPath, next) {
  const parent = getPath(value, jsonPath.slice(0, -1));
  parent[jsonPath[jsonPath.length - 1]] = next;
}

/** Privacy detector hits on the manifest line an icon would produce (a base64 run could, in theory, look like a key). */
function privacyFindings(icons) {
  return icons.flatMap((icon) =>
    scanLine(`"icon": ${JSON.stringify(icon.dataUri)}`, { path: "manifest.json" }).map((finding) => ({
      target: icon.target,
      detector: finding.detector,
    })),
  );
}

function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.error(`generate-icons: ${error.message}`);
    return 2;
  }
  if (options.help) {
    io.log("Usage: node scripts/generate-icons.cjs [--write] [--manifest <path>] [--size <px>]");
    return 0;
  }

  try {
    const text = fs.readFileSync(options.manifest, "utf8");
    const manifest = JSON.parse(text);
    const icons = renderIcons(iconTargets(manifest), { size: options.size });
    const findings = privacyFindings(icons);
    if (findings.length) {
      throw new Error(`Privacy detectors flag ${findings.map((f) => `${f.target} (${f.detector})`).join(", ")}`);
    }
    const { text: nextText, changed } = replaceIcons(text, icons);
    const changedKeys = new Set(changed.map(pathKey));

    const rows = icons.map((icon) => [
      icon.target,
      icon.badge || "-",
      `${icon.size}x${icon.size}`,
      String(icon.pngBytes),
      String(icon.dataUri.length),
      changedKeys.has(pathKey(icon.jsonPath)) ? (options.write ? "updated" : "would update") : "current",
    ]);
    printTable(io, ["target", "badge", "size", "png bytes", "data URI bytes", "manifest"], rows);
    const total = icons.reduce((sum, icon) => sum + icon.dataUri.length, 0);
    io.log(`total data URI bytes: ${total}`);
    for (const cid of unknownChildren(manifest)) io.log(`note: no icon spec for "${cid}", its icon is left as is`);

    if (options.write && nextText !== text) {
      fs.writeFileSync(options.manifest, nextText);
      const shown = path.relative(process.cwd(), options.manifest);
      io.log(`wrote ${changed.length} icon(s) to ${shown.startsWith("..") ? options.manifest : shown}`);
    } else if (options.write) {
      io.log("manifest icons are already current");
    } else if (changed.length) {
      io.log("run with --write to update the manifest");
    }
    return 0;
  } catch (error) {
    io.error(`generate-icons: ${error.message}`);
    return 1;
  }
}

function printTable(io, header, rows) {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const format = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  io.log(format(header));
  for (const row of rows) io.log(format(row));
}

module.exports = {
  iconTargets,
  jsonValueSpans,
  main,
  parseArgs,
  renderIcons,
  replaceIcons,
};

if (require.main === module) {
  process.exitCode = main();
}
