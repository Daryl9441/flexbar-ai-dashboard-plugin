"use strict";

const fs = require("node:fs");
const path = require("node:path");

function pathExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function walkJsonlFiles(root) {
  if (!root || !pathExists(root)) return [];

  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  // Stat each file once, not once per comparison.
  return files
    .map((filePath) => ({ filePath, mtimeMs: safeMtimeMs(filePath) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
    .map((file) => file.filePath);
}

function safeMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readJsonlTail(filePath, maxLines = 200) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// Reads only the last maxBytes of a JSONL file (rollouts can grow to many MB) and
// parses its last maxLines complete lines.
function readJsonlTailBytes(filePath, { maxBytes = 512 * 1024, maxLines = 500 } = {}) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - maxBytes);
  return readJsonlByteRange(filePath, start, size).entries.slice(-maxLines);
}

// Parses the JSONL lines stored in bytes [start, end) of a file. A line that begins
// before `start` is only partly inside the range and is skipped; a last line without
// a trailing newline is kept only when it already parses (otherwise it is still being
// written). `nextOffset` is where a later read of appended bytes should resume, or
// null when the range held no line boundary to resume from.
function readJsonlByteRange(filePath, start, end) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    // One byte before `start` tells whether `start` begins a line.
    const from = Math.max(0, start - 1);
    const buffer = readBytes(fd, from, Math.max(0, end - from));
    let position = 0;
    if (start > 0) {
      if (buffer.length > 0 && buffer[0] === 0x0a) {
        position = 1;
      } else {
        const newline = buffer.indexOf(0x0a, 1);
        if (newline < 0) return { entries: [], nextOffset: null };
        position = newline + 1;
      }
    }

    const entries = [];
    let newline;
    while ((newline = buffer.indexOf(0x0a, position)) >= 0) {
      pushParsedLine(entries, buffer.toString("utf8", position, newline));
      position = newline + 1;
    }
    let nextOffset = from + position;
    if (position < buffer.length && pushParsedLine(entries, buffer.toString("utf8", position))) {
      nextOffset = from + buffer.length;
    }
    return { entries, nextOffset };
  } catch {
    return { entries: [], nextOffset: null };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function readBytes(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const bytesRead = fs.readSync(fd, buffer, filled, length - filled, position + filled);
    if (bytesRead <= 0) break;
    filled += bytesRead;
  }
  return filled < length ? buffer.subarray(0, filled) : buffer;
}

function pushParsedLine(entries, line) {
  if (!line.trim()) return false;
  try {
    entries.push(JSON.parse(line));
    return true;
  } catch {
    return false;
  }
}

function readJsonlFiles(files, maxLinesPerFile = 200) {
  return files.flatMap((filePath) => {
    return readJsonlTail(filePath, maxLinesPerFile).map((entry) => ({
      filePath,
      entry,
    }));
  });
}

function latestFile(files) {
  return files[0] || null;
}

module.exports = {
  latestFile,
  pathExists,
  readJsonlByteRange,
  readJsonlFiles,
  readJsonlTail,
  readJsonlTailBytes,
  safeMtimeMs,
  walkJsonlFiles,
};
