"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DOTS_DEEP_LINK,
  DOTS_WEB_URL,
  dotsOpenCommand,
  openChatGptDots,
} = require("../src/dashboard/dotsAction");
const { createOpenUrlCommand } = require("../src/dashboard/newSessionAction");

// Every command is recorded, never run: no test opens the ChatGPT app.
function recorder(failures = []) {
  const commands = [];
  return {
    commands,
    run: async (command) => {
      commands.push(command);
      if (failures.includes(command.args[command.args.length - 1])) throw Object.assign(new Error("open failed"), { code: 1 });
    },
  };
}

test("the deep link is exactly codex://dots: the app ignores it with a slash or a query", () => {
  assert.equal(DOTS_DEEP_LINK, "codex://dots");
  assert.equal(DOTS_WEB_URL, "https://chatgpt.com/dots");
});

test("on macOS the deep link is opened with /usr/bin/open, no shell and no -a", async () => {
  assert.deepEqual(dotsOpenCommand(DOTS_DEEP_LINK, "darwin"), { file: "/usr/bin/open", args: ["codex://dots"] });

  const { commands, run } = recorder();
  const result = await openChatGptDots({ platform: "darwin", runCommand: run });
  assert.deepEqual(result, { ok: true, target: "app" });
  assert.deepEqual(commands, [{ file: "/usr/bin/open", args: ["codex://dots"] }]);
});

test("when the app cannot take the link, Dots opens on the web", async () => {
  const { commands, run } = recorder([DOTS_DEEP_LINK]);
  const result = await openChatGptDots({ platform: "darwin", runCommand: run });
  assert.deepEqual(result, { ok: true, target: "web" });
  assert.deepEqual(commands.map((command) => command.args), [["codex://dots"], ["https://chatgpt.com/dots"]]);
});

test("when nothing opens, the result says so without the error text", async () => {
  const { run } = recorder([DOTS_DEEP_LINK, DOTS_WEB_URL]);
  assert.deepEqual(await openChatGptDots({ platform: "darwin", runCommand: run }), { ok: false, target: null, reason: "openFailed" });
});

test("Windows uses the same Start-Process command as New Codex Session", async () => {
  assert.deepEqual(dotsOpenCommand(DOTS_DEEP_LINK, "win32"), createOpenUrlCommand(DOTS_DEEP_LINK, "win32"));
  const { commands, run } = recorder();
  await openChatGptDots({ platform: "win32", runCommand: run });
  assert.equal(commands[0].file, "powershell.exe");
});

test("a runCommand that throws synchronously is handled", async () => {
  const result = await openChatGptDots({
    platform: "darwin",
    runCommand: () => {
      throw new Error("spawn failed");
    },
  });
  assert.equal(result.ok, false);
});

test("the module never opens an app on its own: no command runs at load", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "dotsAction.js"), "utf8");
  assert.doesNotMatch(source, /"-a"|'-a'|open -a/, "no -a: the link goes to the registered handler");
  assert.match(source, /"\/usr\/bin\/open"/);
});
