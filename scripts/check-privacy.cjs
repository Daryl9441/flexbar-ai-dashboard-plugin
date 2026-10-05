#!/usr/bin/env node
"use strict";

// Privacy guard: nothing pushed to GitHub may contain tokens, API keys, OAuth credentials, personal emails,
// personal absolute paths, device serial numbers or any term of the local denylist. See CLAUDE.md "Privacy rules".
//
// Usage: node scripts/check-privacy.cjs [--tracked] [--staged] [--range <revs>]... [--pre-push]
//   --tracked        every file tracked at HEAD (`git ls-files`), file names included; binaries and files over 2 MB
//                    are skipped
//   --staged         lines added by `git diff --cached`
//   --range <revs>   lines added by every commit of <revs> ("a..b", or several words such as "HEAD --not --remotes"),
//                    plus each commit's message, author and committer (emails must be GitHub noreply addresses)
//   --pre-push       git pre-push hook mode: reads "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin
//                    and scans the commits each ref would publish
//   (no mode)        --tracked plus the unpushed commits (HEAD --not --remotes)
// Exit code: 0 clean, 1 findings, 2 usage or git error.
//
// False positives: put `privacy-allow` on the line (e.g. in a comment) or add a justified entry to .privacy-allowlist.
// Neither one silences the local denylist.
// Local denylist (lives in .git, never pushed): `git rev-parse --git-path info/privacy-denylist`, plus the file named by
// $PRIVACY_DENYLIST_FILE. One case-insensitive literal per line, `#` starts a comment line. Terms are never printed.
// Env: PRIVACY_UPSTREAM_REFS   (default "upstream/main") commits reachable from these refs are upstream's own work,
//                              already public and not ours to rewrite: they are not scanned at all.
//      PRIVACY_PUBLISHED_REFS  (default "origin/main") commits reachable from these refs are already on the fork's main:
//                              their added lines are scanned, their author/committer/message are not.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const INLINE_ALLOW = "privacy-allow";
const ALLOWLIST_FILE = ".privacy-allowlist";
const DENYLIST_GIT_PATH = "info/privacy-denylist";
const MIN_DENYLIST_TERM = 3;
const DEFAULT_UPSTREAM_REFS = "upstream/main";
const DEFAULT_PUBLISHED_REFS = "origin/main";
const ZERO_SHA = /^0+$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const BINARY_EXTENSIONS = new Set([
  "7z", "a", "avif", "bin", "bmp", "class", "dat", "dll", "dylib", "eot", "exe", "flexplugin", "gif", "gz", "icns",
  "ico", "jar", "jpeg", "jpg", "lib", "mov", "mp3", "mp4", "node", "o", "otf", "pdf", "png", "psd", "pyc", "rar",
  "so", "tgz", "tif", "tiff", "ttf", "wasm", "wav", "webm", "webp", "woff", "woff2", "xz", "zip",
]);

// --- detectors -------------------------------------------------------------------------------------------------

// Path segments that are placeholders, CI runners or shared system folders rather than a person's account.
const PLACEHOLDER_USERS = new Set([
  "me", "you", "user", "username", "example", "runner", "runneradmin", "shared", "public", "default", "jane doe",
  "jdoe", "name", "yourname", "your-name", "your_name", "test", "linuxbrew",
]);
// Placeholder serial numbers documented in CLAUDE.md, plus generic sequences.
const PLACEHOLDER_SERIALS = new Set(["001100AA0001", "0123456789AB", "ABCDEF012345"]);
const ALLOWED_EMAIL_LOCAL_PARTS = new Set(["noreply", "no-reply", "donotreply", "do-not-reply", "git"]);
// RFC 2606 reserved top-level domains.
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);
// "icon@2x.png" and friends are file names, not addresses.
const FILE_EXTENSION_TLDS = new Set([
  "cjs", "css", "gif", "html", "ico", "jpeg", "jpg", "js", "json", "jsx", "map", "md", "mjs", "node", "png", "svg",
  "ts", "tsx", "txt", "vue", "webp",
]);
const NOREPLY_EMAIL = /^(?:(?:\d+\+)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?@users\.noreply\.github\.com|noreply@github\.com)$/i;
const PLACEHOLDER_WORDS =
  /example|sample|placeholder|dummy|fake|test|changeme|change[_-]me|redacted|your|xxxx|todo|secret|token|password|passwd|api[_-]?key|replace|insert|mock|demo|undefined|null/i;
const KNOWN_PREFIX = /^(?:github_pat_|gh[pousr]_|sk-ant-(?:[a-z]+\d*-)?|sk-(?:proj-|svcacct-|admin-)?|AKIA|ASIA|xox[abpr]-|AIza|eyJ)/;
const PATH_NAME = String.raw`([^\s/\\"'\x60$<>{}()\[\]*%:;,|&=?#]+)`;

const DETECTORS = [
  {
    id: "private-key",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
    snippet: (m) => m[0],
  },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    id: "openai-key",
    re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    // Real keys mix letters and digits; this keeps kebab-case identifiers such as "sk-some-long-name" out.
    check: (m) => /\d/.test(m[0]) && /[A-Za-z]/.test(m[0].slice(3)),
  },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "slack-token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, check: (m) => /\d/.test(m[0]) },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  {
    id: "bearer-token",
    re: /\bauthorization\b["'`]?\s*[:=]?\s*["'`]?\s*bearer\s+([A-Za-z0-9._~+/=-]{20,})/gi,
    check: (m) => looksLikeSecret(m[1]),
    snippet: (m) => `Bearer ${maskSecret(m[1])}`,
  },
  {
    id: "generic-secret",
    re: /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token))["'`]?\s*(?:=>|[:=])\s*(["'`])([^"'`\s]{12,})\2/gi,
    check: (m) => looksLikeSecret(m[3]),
    snippet: (m) => `${m[1]}=${maskSecret(m[3])}`,
  },
  {
    id: "personal-path",
    re: new RegExp(String.raw`(?<![A-Za-z0-9_.~-])/(?:Users|home)/` + PATH_NAME, "g"),
    check: (m, line) => !isPlaceholderUser(m[1], line.slice(m.index + m[0].length)),
    snippet: (m) => m[0].slice(0, m[0].length - m[1].length) + maskTerm(m[1]),
  },
  {
    id: "personal-path",
    re: new RegExp(String.raw`\b[A-Za-z]:\\{1,2}Users\\{1,2}` + PATH_NAME, "gi"),
    check: (m, line) => !isPlaceholderUser(m[1], line.slice(m.index + m[0].length)),
    snippet: (m) => m[0].slice(0, m[0].length - m[1].length) + maskTerm(m[1]),
  },
  {
    id: "email",
    re: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g,
    check: (m) => !isAllowedEmail(m[1], m[2]),
    snippet: (m) => `${maskTerm(m[1])}@${maskTerm(m[2])}`,
  },
  {
    // Flexbar serial numbers: 12 upper-case hex digits. Only on lines that talk about a serial, device or Flexbar,
    // which keeps hashes and colors out.
    id: "device-serial",
    re: /(?<![0-9A-Za-z])[0-9A-F]{12}(?![0-9A-Za-z])/g,
    check: (m, line) =>
      /serial|flexbar|device|\bsn\b/i.test(line) && /\d/.test(m[0]) && /[A-F]/.test(m[0]) && !isPlaceholderSerial(m[0]),
    snippet: (m) => maskTerm(m[0]),
  },
];

function maskTerm(term, keep = 2) {
  return `${String(term).slice(0, keep)}…`;
}

/** Keeps a token's well-known prefix ("ghp_", "sk-ant-", "AKIA", ...) plus 2 characters, never the secret itself. */
function maskSecret(value) {
  const text = String(value);
  const prefix = KNOWN_PREFIX.exec(text);
  return `${text.slice(0, (prefix ? prefix[0].length : 0) + 2)}…(${text.length} chars)`;
}

function maskEmailAddress(address) {
  const text = String(address || "");
  if (!text) return "(empty)";
  const at = text.lastIndexOf("@");
  return at < 0 ? maskTerm(text) : `${maskTerm(text.slice(0, at))}@${maskTerm(text.slice(at + 1))}`;
}

function isPlaceholderValue(value) {
  return /[$<>{}%*…]|\.\.\./.test(value) || PLACEHOLDER_WORDS.test(value) || /^(.)\1+$/.test(value);
}

function shannonEntropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** A quoted value that is not a placeholder, URL or word: mixes letters and digits and is reasonably random. */
function looksLikeSecret(value) {
  if (isPlaceholderValue(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  return shannonEntropy(value) >= 3;
}

function isPlaceholderUser(name, rest = "") {
  const lower = name.toLowerCase();
  // "…" marks an elided or masked name ("/Users/…", "/Users/al…"), as in this script's own reports.
  if (name.length <= 1 || /^\.+$/.test(name) || name.includes("…") || PLACEHOLDER_USERS.has(lower)) return true;
  const nextWord = /^ ([^\s/\\"'`]+)/.exec(rest); // "/Users/Jane Doe/..."
  return Boolean(nextWord) && PLACEHOLDER_USERS.has(`${lower} ${nextWord[1].toLowerCase()}`);
}

function isAllowedEmail(local, domain) {
  const l = local.toLowerCase();
  const d = domain.toLowerCase();
  const tld = d.slice(d.lastIndexOf(".") + 1);
  return (
    d === "users.noreply.github.com" ||
    d.endsWith(".users.noreply.github.com") ||
    (l === "noreply" && d === "github.com") ||
    ALLOWED_EMAIL_LOCAL_PARTS.has(l) ||
    /(?:^|\.)example\.(?:com|org|net)$/.test(d) ||
    RESERVED_TLDS.has(tld) ||
    FILE_EXTENSION_TLDS.has(tld)
  );
}

function isPlaceholderSerial(serial) {
  return PLACEHOLDER_SERIALS.has(serial) || /^(.)\1+$/.test(serial);
}

function isNoreplyEmail(address) {
  return NOREPLY_EMAIL.test(String(address || "").trim());
}

// --- denylist and allowlist ------------------------------------------------------------------------------------

/**
 * Reads denylist files (missing files are skipped). Returns lower-cased terms; never logs a term.
 * onWarning receives messages that name only the file and line.
 */
function loadDenylist(files, { onWarning = () => {} } = {}) {
  const terms = new Set();
  for (const file of [].concat(files || [])) {
    if (!file) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    text.split(/\r?\n/).forEach((raw, index) => {
      const term = raw.trim();
      if (!term || term.startsWith("#")) return;
      if (term.length < MIN_DENYLIST_TERM) {
        onWarning(`${path.basename(file)}:${index + 1}: entry ignored, shorter than ${MIN_DENYLIST_TERM} characters`);
        return;
      }
      terms.add(term.toLowerCase());
    });
  }
  return [...terms];
}

/** Returns the occurrences (original case) of denylist terms in text, one per term. */
function findDenylisted(text, denylist) {
  if (!text || !denylist || !denylist.length) return [];
  const lower = String(text).toLowerCase();
  const hits = [];
  for (const term of denylist) {
    const index = lower.indexOf(term);
    if (index >= 0) hits.push(String(text).slice(index, index + term.length));
  }
  return hits;
}

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * .privacy-allowlist: one entry per line, `<detector|*> <path-glob> [<literal>]`. A finding is allowed when its detector
 * and path match and, if given, the literal occurs in the matched text. `#` lines are comments: every entry needs one
 * saying why it is safe. The denylist and the commit email rule cannot be allowlisted.
 */
function parseAllowlist(text) {
  const entries = [];
  String(text || "").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const match = /^(\S+)\s+(\S+)(?:\s+(.+))?$/.exec(line);
    if (!match) throw new UsageError(`${ALLOWLIST_FILE}:${index + 1}: expected "<detector|*> <path-glob> [<literal>]"`);
    entries.push({ detector: match[1], path: globToRegExp(match[2]), literal: match[3] ? match[3].trim() : null });
  });
  return entries;
}

function loadAllowlist(file) {
  try {
    return parseAllowlist(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function isAllowlisted(detector, file, matchText, allowlist) {
  return (allowlist || []).some(
    (entry) =>
      (entry.detector === "*" || entry.detector === detector) &&
      entry.path.test(file) &&
      (!entry.literal || matchText.includes(entry.literal)),
  );
}

// --- scanning --------------------------------------------------------------------------------------------------

/**
 * Finds the private data in one line: [{ detector, snippet, start, end }] with masked snippets. `file` is the real
 * path, matched against .privacy-allowlist. patterns=false skips the pattern detectors (the denylist always runs);
 * so does `privacy-allow` on the line.
 */
function findHits(text, { file = "<text>", denylist = [], allowlist = [], patterns = true } = {}) {
  const hits = [];
  const value = String(text);
  if (patterns && !value.includes(INLINE_ALLOW)) {
    for (const detector of DETECTORS) {
      for (const m of value.matchAll(detector.re)) {
        if (detector.check && !detector.check(m, value)) continue;
        if (isAllowlisted(detector.id, file, m[0], allowlist)) continue;
        const snippet = detector.snippet ? detector.snippet(m) : maskSecret(m[0]);
        hits.push({ detector: detector.id, snippet, start: m.index, end: m.index + m[0].length });
      }
    }
  }
  const lower = value.toLowerCase();
  for (const term of denylist || []) {
    const start = lower.indexOf(term);
    if (start >= 0) hits.push({ detector: "denylist", snippet: maskTerm(value.slice(start)), start, end: start + term.length });
  }
  return hits;
}

/** The path as printed: every private part of it masked, so that a report never repeats what it flags. */
function displayPath(file, options = {}) {
  const hits = findHits(file, { ...options, file, patterns: true }).sort((a, b) => a.start - b.start);
  let shown = "";
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    shown += file.slice(cursor, hit.start) + maskTerm(file.slice(hit.start, hit.end));
    cursor = hit.end;
  }
  return shown + file.slice(cursor);
}

/**
 * Scans one line. Returns findings { path, line, detector, snippet[, commit] } with masked snippets only.
 * `path` is the real path (for .privacy-allowlist), `shownPath` the one to report (default: displayPath(path)).
 */
function scanLine(text, options = {}) {
  const { path: file = "<text>", line = 1, commit } = options;
  const hits = findHits(text, { ...options, file });
  if (!hits.length) return [];
  const shown = options.shownPath ?? displayPath(file, options);
  return hits.map(({ detector, snippet }) => ({ path: shown, line, detector, snippet, ...(commit ? { commit } : {}) }));
}

/** Scans text line by line (line numbers start at options.firstLine, default 1). */
function scanText(text, options = {}) {
  const { firstLine = 1, ...rest } = options;
  const findings = [];
  String(text).split(/\r?\n/).forEach((lineText, index) => {
    findings.push(...scanLine(lineText, { ...rest, line: firstLine + index }));
  });
  return findings;
}

/** Scans a file name (reported without a line number). */
function scanPathName(file, options = {}) {
  return scanLine(file, { ...options, path: file, line: 0, patterns: true }).map((finding) => ({
    ...finding,
    snippet: `${finding.snippet} (in file name)`,
  }));
}

function unquoteGitPath(text) {
  if (!text.startsWith('"')) return text;
  const bytes = [];
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = text[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(text.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 })[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function parsePatchPath(text) {
  const raw = unquoteGitPath(text.replace(/\t$/, ""));
  if (raw === "/dev/null") return null;
  return raw.startsWith("b/") ? raw.slice(2) : raw;
}

/**
 * Scans the lines a patch adds: `git diff` / `git log -p --format=%x01%H` output, combined (`--cc`) merge diffs
 * included (only lines that are new relative to every parent). Also scans each added or changed file's name once.
 */
function scanPatch(patchText, { denylist = [], allowlist = [], seenPaths = new Set() } = {}) {
  const findings = [];
  let commit;
  let file = null;
  let newLine = 0;
  let width = 1;
  let inHunk = false;
  for (const raw of String(patchText).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (inHunk) {
      const first = line[0];
      if (line === "" || first === " " || first === "+" || first === "-") {
        const prefix = line.slice(0, width);
        if (prefix.includes("-")) continue;
        if (file && prefix.length === width && /^\++$/.test(prefix)) {
          findings.push(
            ...scanLine(line.slice(width), { path: file, line: newLine, commit, denylist, allowlist, patterns: file !== ALLOWLIST_FILE }),
          );
        }
        newLine++;
        continue;
      }
      if (first === "\\") continue; // "\ No newline at end of file"
      inHunk = false;
    }
    if (line.startsWith("\x01")) {
      commit = line.slice(1).trim();
      file = null;
    } else if (line.startsWith("diff ")) {
      file = null;
    } else if (line.startsWith("+++ ")) {
      file = parsePatchPath(line.slice(4));
      if (file && !seenPaths.has(file)) {
        seenPaths.add(file);
        findings.push(...scanPathName(file, { commit, denylist, allowlist }));
      }
    } else {
      const hunk = /^(@{2,}) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? \1/.exec(line);
      if (hunk) {
        width = hunk[1].length - 1;
        newLine = Number(hunk[2]);
        inHunk = true;
      }
    }
  }
  return findings;
}

/**
 * Commit metadata rules: author and committer emails must be GitHub noreply addresses; author/committer names and
 * emails must not contain denylist terms; the message gets the same scan as file content.
 */
function scanCommitMeta(commit, { denylist = [], allowlist = [] } = {}) {
  const { sha, authorName = "", authorEmail = "", committerName = "", committerEmail = "", message = "" } = commit;
  const where = `commit ${String(sha).slice(0, 12)}`;
  const findings = [];
  if (!isNoreplyEmail(authorEmail)) {
    findings.push({ path: where, line: 0, detector: "author-email", snippet: maskEmailAddress(authorEmail) });
  }
  if (!isNoreplyEmail(committerEmail)) {
    findings.push({ path: where, line: 0, detector: "committer-email", snippet: maskEmailAddress(committerEmail) });
  }
  const fields = [
    ["author name", authorName],
    ["author email", authorEmail],
    ["committer name", committerName],
    ["committer email", committerEmail],
  ];
  for (const [label, value] of fields) {
    for (const hit of findDenylisted(value, denylist)) {
      findings.push({ path: where, line: 0, detector: "denylist", snippet: `${label}: ${maskTerm(hit)}` });
    }
  }
  findings.push(...scanText(String(message).replace(/\n+$/, ""), { path: `${where} message`, denylist, allowlist }));
  return findings;
}

/** Parses `git log --format=%x01%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B` output. */
function parseCommitLog(text) {
  return String(text)
    .split("\x01")
    .map((chunk) => chunk.replace(/^\n/, ""))
    .filter(Boolean)
    .map((chunk) => {
      const [sha, authorName, authorEmail, committerName, committerEmail, ...message] = chunk.split("\x00");
      return { sha: sha.trim(), authorName, authorEmail, committerName, committerEmail, message: message.join("\x00") };
    });
}

/**
 * Parses git pre-push stdin. Each pushed ref gets the rev-list arguments of the commits it publishes:
 * "<remote>..<local>", or "<local> --not --remotes" for a new remote ref. Deletions get revArgs null.
 */
function parsePrePushLines(text) {
  const updates = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 4 || !SHA.test(parts[1]) || !SHA.test(parts[3])) {
      throw new UsageError(`unexpected pre-push input line: ${line}`);
    }
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    const deleted = ZERO_SHA.test(localSha);
    const newRef = ZERO_SHA.test(remoteSha);
    let revArgs = null;
    if (!deleted) revArgs = newRef ? [localSha, "--not", "--remotes"] : [`${remoteSha}..${localSha}`];
    updates.push({ localRef, localSha, remoteRef, remoteSha, deleted, newRef, revArgs });
  }
  return updates;
}

function formatFinding(finding) {
  const where = finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
  const suffix = finding.commit ? ` (commit ${finding.commit.slice(0, 12)})` : "";
  return `${where} [${finding.detector}] ${finding.snippet}${suffix}`;
}

// --- git -------------------------------------------------------------------------------------------------------

class UsageError extends Error {}
class GitError extends Error {}

function runGit(args, { cwd, input, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new GitError(`cannot run git: ${result.error.message}`);
  if (result.status !== 0) {
    if (allowFailure) return null;
    const detail = String(result.stderr || "").trim().split("\n")[0];
    throw new GitError(`git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) || ""} failed: ${detail}`);
  }
  return result.stdout;
}

function gitLines(args, options) {
  return runGit(args, options).split("\n").map((line) => line.trim()).filter(Boolean);
}

// Plain git, whatever the user's config: no colors, pagers, external diff drivers, signatures or prefixes.
const GIT_CONFIG = [
  "-c", "core.quotePath=false",
  "-c", "color.ui=false",
  "-c", "log.showSignature=false",
  "-c", "log.showRoot=true",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.relative=false",
];
const PATCH_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "-U0", "--src-prefix=a/", "--dst-prefix=b/"];
const REV_OPTION = /^--(?:not|all|remotes|branches|tags)(?:=.+)?$|^--(?:glob|exclude)=.+$/;

function validateRevArgs(revArgs) {
  for (const arg of revArgs) {
    if (arg.startsWith("-") && !REV_OPTION.test(arg)) throw new UsageError(`unsupported option in a range: ${arg}`);
  }
  return revArgs;
}

function existingRefs(spec, cwd) {
  return String(spec || "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((ref) => !ref.startsWith("-") && runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, allowFailure: true }) !== null);
}

function scanTracked(ctx, stats) {
  const findings = [];
  const files = runGit(["ls-files", "-z", "--cached"], { cwd: ctx.root }).split("\0").filter(Boolean);
  for (const file of new Set(files)) {
    findings.push(...scanPathName(file, ctx));
    const full = path.join(ctx.root, file);
    let info;
    try {
      info = fs.lstatSync(full);
    } catch {
      continue; // deleted in the working tree
    }
    if (!info.isFile()) continue; // symlink, submodule
    const extension = path.extname(file).slice(1).toLowerCase();
    if (info.size > MAX_FILE_BYTES || BINARY_EXTENSIONS.has(extension)) {
      stats.skipped++;
      continue;
    }
    const buffer = fs.readFileSync(full);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      stats.skipped++;
      continue;
    }
    stats.files++;
    findings.push(...scanText(buffer.toString("utf8"), { ...ctx, path: file, patterns: file !== ALLOWLIST_FILE }));
  }
  return findings;
}

function scanStaged(ctx, stats) {
  const patch = runGit([...GIT_CONFIG, "diff", "--cached", ...PATCH_OPTIONS], { cwd: ctx.root });
  stats.staged = true;
  return scanPatch(patch, ctx);
}

function scanRange(revArgs, ctx, stats) {
  validateRevArgs(revArgs);
  const cwd = ctx.root;
  const upstream = existingRefs(ctx.env.PRIVACY_UPSTREAM_REFS ?? DEFAULT_UPSTREAM_REFS, cwd).map((ref) => `^${ref}`);
  const published = existingRefs(ctx.env.PRIVACY_PUBLISHED_REFS ?? DEFAULT_PUBLISHED_REFS, cwd).map((ref) => `^${ref}`);
  // The ^refs go first: a `--not` inside revArgs only flips the arguments after it.
  const commits = gitLines(["rev-list", ...upstream, ...revArgs, "--"], { cwd });
  if (!commits.length) return [];
  stats.commits += commits.length;
  const own = new Set(gitLines(["rev-list", ...upstream, ...published, ...revArgs, "--"], { cwd }));
  const patch = runGit([...GIT_CONFIG, "log", "-p", "--cc", ...PATCH_OPTIONS, "--format=%x01%H", ...upstream, ...revArgs, "--"], { cwd });
  const findings = scanPatch(patch, ctx);
  const log = runGit([...GIT_CONFIG, "log", "--no-color", "--format=%x01%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B", ...upstream, ...revArgs, "--"], { cwd });
  for (const commit of parseCommitLog(log)) {
    if (own.has(commit.sha)) findings.push(...scanCommitMeta(commit, ctx));
  }
  return findings;
}

function commitExists(sha, cwd) {
  return runGit(["cat-file", "-e", `${sha}^{commit}`], { cwd, allowFailure: true }) !== null;
}

// --- CLI -------------------------------------------------------------------------------------------------------

const USAGE = `Usage: node scripts/check-privacy.cjs [--tracked] [--staged] [--range <revs>]... [--pre-push]
  --tracked        scan every tracked file (and file name)
  --staged         scan lines added in the index (git diff --cached)
  --range <revs>   scan lines added by the commits of <revs> plus their messages and author/committer
                   (e.g. "main..HEAD" or "HEAD --not --remotes")
  --pre-push       git pre-push hook mode (reads the pushed refs on stdin)
  (no mode)        --tracked plus the unpushed commits (HEAD --not --remotes)
Exit code: 0 clean, 1 findings, 2 usage or git error. See CLAUDE.md "Privacy rules".
`;

function parseArgs(argv) {
  const options = { tracked: false, staged: false, prePush: false, unpushed: false, ranges: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tracked") options.tracked = true;
    else if (arg === "--staged") options.staged = true;
    else if (arg === "--pre-push") options.prePush = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--range" || arg.startsWith("--range=")) {
      const value = arg === "--range" ? argv[++i] : arg.slice("--range=".length);
      if (!value || !value.trim()) throw new UsageError("--range needs a revision range");
      options.ranges.push(validateRevArgs(value.trim().split(/\s+/)));
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (!options.tracked && !options.staged && !options.prePush && !options.ranges.length) {
    options.tracked = true;
    options.unpushed = true;
  }
  return options;
}

function main(argv = process.argv.slice(2), io = {}) {
  const { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), env = process.env } = io;
  const readStdin = io.readStdin || (() => fs.readFileSync(0, "utf8"));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`check-privacy: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  try {
    const root = runGit(["rev-parse", "--show-toplevel"], { cwd }).trim();
    const denylistFiles = [path.resolve(cwd, runGit(["rev-parse", "--git-path", DENYLIST_GIT_PATH], { cwd }).trim())];
    if (env.PRIVACY_DENYLIST_FILE) {
      const extra = path.resolve(cwd, env.PRIVACY_DENYLIST_FILE);
      if (!fs.existsSync(extra)) stderr.write("check-privacy: warning: $PRIVACY_DENYLIST_FILE does not exist\n");
      denylistFiles.push(extra);
    }
    const denylist = loadDenylist(denylistFiles, { onWarning: (message) => stderr.write(`check-privacy: warning: denylist ${message}\n`) });
    const ctx = { root, env, denylist, allowlist: loadAllowlist(path.join(root, ALLOWLIST_FILE)), seenPaths: new Set() };
    const stats = { files: 0, skipped: 0, commits: 0, staged: false };
    const findings = [];
    if (options.tracked) findings.push(...scanTracked(ctx, stats));
    if (options.staged) findings.push(...scanStaged(ctx, stats));
    const ranges = [...options.ranges];
    if (options.unpushed && runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root, allowFailure: true }) !== null) {
      ranges.push(["HEAD", "--not", "--remotes"]);
    }
    if (options.prePush) {
      for (const update of parsePrePushLines(readStdin())) {
        if (update.deleted) continue;
        // A remote tip we have never fetched (e.g. someone else force-pushed): scan everything not on a remote yet.
        ranges.push(update.newRef || commitExists(update.remoteSha, root) ? update.revArgs : [update.localSha, "--not", "--remotes"]);
      }
    }
    for (const revArgs of ranges) findings.push(...scanRange(revArgs, ctx, stats));

    const lines = [...new Set(findings.map(formatFinding))];
    const scanned = [
      options.tracked ? `${stats.files} files (${stats.skipped} binary or large skipped)` : null,
      options.staged ? "staged changes" : null,
      ranges.length ? `${stats.commits} commit${stats.commits === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join(", ") || "nothing";
    if (!lines.length) {
      stdout.write(`check-privacy: clean (${denylist.length ? "with" : "without"} local denylist; scanned ${scanned})\n`);
      return 0;
    }
    stdout.write(`${lines.join("\n")}\n`);
    stdout.write(
      `check-privacy: ${lines.length} finding(s) in ${scanned}${options.prePush ? " - push blocked" : ""}.\n` +
        "  Remove the value or use a placeholder (/Users/me, 001100AA0001, example.com); rewrite commits that already\n" +
        "  contain it. A checked false positive: add `privacy-allow` to the line or a justified entry to .privacy-allowlist.\n",
    );
    return 1;
  } catch (error) {
    if (error instanceof UsageError || error instanceof GitError) {
      stderr.write(`check-privacy: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

module.exports = {
  DETECTORS,
  formatFinding,
  globToRegExp,
  isAllowedEmail,
  isNoreplyEmail,
  isPlaceholderUser,
  loadAllowlist,
  loadDenylist,
  looksLikeSecret,
  main,
  maskSecret,
  maskTerm,
  parseAllowlist,
  parseArgs,
  parseCommitLog,
  parsePrePushLines,
  scanCommitMeta,
  scanLine,
  scanPatch,
  scanPathName,
  scanText,
};

if (require.main === module) {
  process.exitCode = main();
}
