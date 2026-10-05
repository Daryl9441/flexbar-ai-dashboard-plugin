"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WINDOWS_MAX_URL_LENGTH,
  buildCodexNewThreadUrl,
  createOpenUrlCommand,
  listRecentProjectPaths,
  normalizeCodexAppMode,
  openNewCodexSession,
  projectLabel,
  validateProjectPath,
} = require("../src/dashboard/newSessionAction");

function parse(url) {
  const parsed = new URL(url);
  return { parsed, params: Object.fromEntries(parsed.searchParams) };
}

test("new Codex thread URL defaults to Codex mode in the ChatGPT app", () => {
  const { parsed, params } = parse(buildCodexNewThreadUrl());
  assert.equal(parsed.protocol, "codex:");
  assert.equal(parsed.host, "threads");
  assert.equal(parsed.pathname, "/new");
  assert.deepEqual(params, { mode: "codex" });
});

test("new Codex thread URL carries project path and prompt, encoded", () => {
  const url = buildCodexNewThreadUrl({
    mode: "work",
    projectPath: " /Users/me/My Project ",
    prompt: "修复 bug & run tests?",
  });
  const { params } = parse(url);
  assert.deepEqual(params, {
    mode: "work",
    path: "/Users/me/My Project",
    prompt: "修复 bug & run tests?",
  });
  assert.ok(!url.includes(" "), "spaces must be encoded");
});

test("new Codex thread URL omits blank prompt and path", () => {
  const { params } = parse(buildCodexNewThreadUrl({ projectPath: "  ", prompt: "\n " }));
  assert.deepEqual(params, { mode: "codex" });
});

test("unknown modes fall back to codex", () => {
  assert.equal(normalizeCodexAppMode("CHAT"), "chat");
  assert.equal(normalizeCodexAppMode("cloud"), "codex");
  assert.equal(normalizeCodexAppMode(undefined), "codex");
});

test("project path validation matches what the ChatGPT app accepts", () => {
  assert.deepEqual(validateProjectPath(""), { ok: true, path: "" });
  assert.equal(validateProjectPath("/Users/me/repo").ok, true);
  assert.equal(validateProjectPath("C:\\Users\\me\\repo").ok, true);
  assert.equal(validateProjectPath("C:/Users/me/repo").ok, true);
  assert.equal(validateProjectPath("relative/repo").ok, false);
  assert.equal(validateProjectPath("~/repo").ok, false);
  assert.equal(validateProjectPath("//server/share").ok, false);
  assert.equal(validateProjectPath("\\\\server\\share").ok, false);
  assert.throws(() => buildCodexNewThreadUrl({ projectPath: "repo" }), /absolute path/);
});

test("open URL command uses open on macOS without a shell", () => {
  const url = "codex://threads/new?mode=codex&prompt=a%20%22b%22";
  assert.deepEqual(createOpenUrlCommand(url, "darwin"), { file: "open", args: [url] });
});

test("open URL command on Windows passes the URL base64-encoded to Start-Process", () => {
  const url = "codex://threads/new?mode=codex&path=C%3A%5Crepo&prompt=x";
  const command = createOpenUrlCommand(url, "win32");
  assert.equal(command.file, "powershell.exe");
  const encoded = command.args[command.args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /^Start-Process -FilePath /);
  const inner = script.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.equal(Buffer.from(inner, "base64").toString("utf16le"), url);
});

test("openNewCodexSession runs the open command for the built URL", async () => {
  const commands = [];
  const result = await openNewCodexSession({
    projectPath: "/Users/me/repo",
    platform: "darwin",
    runCommand: async (command) => commands.push(command),
  });
  assert.equal(result.ok, true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].file, "open");
  assert.equal(commands[0].args[0], result.url);
  assert.equal(new URL(result.url).searchParams.get("path"), "/Users/me/repo");
});

test("openNewCodexSession reports failures without throwing", async () => {
  const failed = await openNewCodexSession({
    platform: "darwin",
    runCommand: async () => {
      throw new Error("No application knows how to open codex://");
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /No application/);

  let ran = false;
  const invalid = await openNewCodexSession({
    projectPath: "not/absolute",
    platform: "darwin",
    runCommand: async () => {
      ran = true;
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(ran, false);
});

test("recent project paths come from Codex sessions, deduped and valid only", () => {
  const snapshot = {
    providers: {
      codex: {
        sessions: [
          { cwd: "/Users/me/a" },
          { cwd: "/Users/me/b" },
          { cwd: "/Users/me/a" },
          { cwd: null },
          { cwd: "relative" },
          { cwd: " /Users/me/c " },
        ],
      },
    },
  };
  assert.deepEqual(listRecentProjectPaths(snapshot), ["/Users/me/a", "/Users/me/b", "/Users/me/c"]);
  assert.deepEqual(listRecentProjectPaths(snapshot, 1), ["/Users/me/a"]);
  assert.deepEqual(listRecentProjectPaths(null), []);
});

test("project label is the folder name", () => {
  assert.equal(projectLabel("/Users/me/flexbar-ai-dashboard-plugin/"), "flexbar-ai-dashboard-plugin");
  assert.equal(projectLabel("C:\\work\\repo"), "repo");
  assert.equal(projectLabel(""), "");
});

test("openNewCodexSession tags why it failed so the key can show a specific message", async () => {
  let ran = 0;
  const run = async () => {
    ran += 1;
  };

  const invalid = await openNewCodexSession({ projectPath: "~/repo", platform: "darwin", runCommand: run });
  assert.equal(invalid.reason, "invalidProject");

  const long = await openNewCodexSession({ prompt: "修".repeat(300), platform: "win32", runCommand: run });
  assert.equal(long.ok, false);
  assert.equal(long.reason, "promptTooLong");
  assert.ok(long.url.length > WINDOWS_MAX_URL_LENGTH);
  assert.equal(ran, 0, "nothing is opened for rejected requests");

  const macLong = await openNewCodexSession({ prompt: "修".repeat(300), platform: "darwin", runCommand: run });
  assert.equal(macLong.ok, true, "macOS open handles long URLs");

  const failed = await openNewCodexSession({
    platform: "darwin",
    runCommand: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(failed.reason, "openFailed");
});
