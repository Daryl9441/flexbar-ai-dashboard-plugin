"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_FLEXCLI_SPEC,
  buildNodeOptions,
  configBackupPath,
  isFlexcliModuleUrl,
  needsImportAssertionCompat,
  npxCommand,
  packPluginDir,
  quoteWindowsShellArg,
  rewriteImportAssertions,
  runFlexcli,
  setConfigJsonAside,
} = require("../scripts/flexcli.cjs");

const repoRoot = path.join(__dirname, "..");
const wrapperPath = path.join(repoRoot, "scripts", "flexcli.cjs");
const PACK = ["plugin", "pack", "--path", "com.example.demo.plugin"];

function tempDir(t, prefix = "flexcli-wrapper-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** <root>/com.example.demo.plugin with an optional config.json. */
function makeWorkspace(t, { config } = {}) {
  const root = tempDir(t);
  const pluginDir = path.join(root, "com.example.demo.plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({ uuid: "com.example.demo" }));
  if (config !== undefined) fs.writeFileSync(path.join(pluginDir, "config.json"), config);
  return { root, pluginDir, configPath: path.join(pluginDir, "config.json"), backupPath: configBackupPath(pluginDir) };
}

function fakeSpawn(onSpawn = () => ({ status: 0 })) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return onSpawn({ command, args, options });
  };
  return { calls, spawnFn };
}

const POSIX = { platform: "darwin", execPath: "/usr/local/bin/node", nodeVersion: "20.18.0", exists: () => false, log: () => {} };

test("rewriteImportAssertions turns JSON import assertions into import attributes", () => {
  assert.equal(
    rewriteImportAssertions("import schema from '../assets/manifest_schema.json' assert { type: 'json' };"),
    "import schema from '../assets/manifest_schema.json' with { type: 'json' };"
  );
  assert.equal(
    rewriteImportAssertions('import a from "./a.json" assert {type:"json"}'),
    'import a from "./a.json" with {type:"json"}'
  );
  const untouched = "import b from './b.json' with { type: 'json' };\nassert(ok);\nassert.equal(x, 1);";
  assert.equal(rewriteImportAssertions(untouched), untouched);
});

test("isFlexcliModuleUrl only matches @eniac/flexcli modules", () => {
  assert.equal(isFlexcliModuleUrl("file:///Users/me/.npm/_npx/abc/node_modules/@eniac/flexcli/src/commands/pack.js"), true);
  assert.equal(isFlexcliModuleUrl("file:///repo/node_modules/@eniac/flexdesigner/dist/index.js"), false);
  assert.equal(isFlexcliModuleUrl("file:///repo/node_modules/@eniac/flexcli/src/assets/manifest_schema.json"), false);
});

test("the compat hook is only needed on Node.js 22 and later", () => {
  assert.equal(needsImportAssertionCompat("18.20.4"), false);
  assert.equal(needsImportAssertionCompat("20.18.0"), false);
  assert.equal(needsImportAssertionCompat("22.0.0"), true);
  assert.equal(needsImportAssertionCompat("v25.9.0"), true);
});

test("buildNodeOptions appends the --import flag once", () => {
  const url = "file:///repo/scripts/flexcli-compat.mjs";
  assert.equal(buildNodeOptions(undefined, url), `--import=${url}`);
  assert.equal(buildNodeOptions("--max-old-space-size=4096", url), `--max-old-space-size=4096 --import=${url}`);
  assert.equal(buildNodeOptions(`--import=${url}`, url), `--import=${url}`);
});

test("compat hook lets FlexCLI-style import assertions load on this Node.js", { skip: !needsImportAssertionCompat() }, (t) => {
  const root = tempDir(t, "flexcli-compat-");
  const moduleDir = path.join(root, "node_modules", "@eniac", "flexcli", "src");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "data.json"), JSON.stringify({ ok: "yes" }), "utf8");
  fs.writeFileSync(
    path.join(moduleDir, "probe.js"),
    "import data from './data.json' assert { type: 'json' };\nconsole.log(data.ok);\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "node_modules", "@eniac", "flexcli", "package.json"), '{ "type": "module" }', "utf8");

  const hook = pathToFileURL(path.join(repoRoot, "scripts", "flexcli-compat.mjs")).href;
  const child = spawnSync(process.execPath, [`--import=${hook}`, path.join(moduleDir, "probe.js")], { encoding: "utf8" });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "yes");
});

test("npxCommand runs npx without a shell whenever it can find npx-cli.js", () => {
  const exists = (file) => file.endsWith("npx-cli.js");
  assert.deepEqual(
    npxCommand({ npm_execpath: "/opt/npm/bin/npm-cli.js" }, { platform: "darwin", execPath: "/opt/node", exists }),
    { command: "/opt/node", prefix: ["/opt/npm/bin/npx-cli.js"], shell: false }
  );
  assert.deepEqual(
    npxCommand({ npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" }, {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      exists,
    }),
    { command: "C:\\Program Files\\nodejs\\node.exe", prefix: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"], shell: false }
  );

  // pnpm / yarn (or no npm run at all) on Windows: the npm bundled with Node.js.
  assert.deepEqual(
    npxCommand({ npm_execpath: "C:\\pnpm\\pnpm.cjs" }, { platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe", exists }),
    { command: "C:\\Program Files\\nodejs\\node.exe", prefix: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"], shell: false }
  );
  assert.deepEqual(
    npxCommand({}, { platform: "win32", execPath: "C:\\nvm\\node.exe", exists: () => false }),
    { command: "npx.cmd", prefix: [], shell: true }
  );
  assert.deepEqual(npxCommand({}, { platform: "linux", execPath: "/usr/bin/node", exists }), { command: "npx", prefix: [], shell: false });
});

test("quoteWindowsShellArg keeps paths with spaces and cmd.exe metacharacters as one argument", () => {
  assert.equal(quoteWindowsShellArg("plugin"), "plugin");
  assert.equal(quoteWindowsShellArg("@eniac/flexcli@1.0.7"), "@eniac/flexcli@1.0.7");
  assert.equal(quoteWindowsShellArg("--uuid=com.aspen.flexbar-ai-dashboard"), '"--uuid=com.aspen.flexbar-ai-dashboard"');
  assert.equal(quoteWindowsShellArg("C:\\Users\\Jane Doe\\my plugin.plugin"), '"C:\\Users\\Jane Doe\\my plugin.plugin"');
  assert.equal(quoteWindowsShellArg("C:\\a b\\"), '"C:\\a b\\\\"');
  assert.equal(quoteWindowsShellArg("R&D"), '"R&D"');
  assert.equal(quoteWindowsShellArg(""), '""');
  assert.throws(() => quoteWindowsShellArg("100%"), /Cannot pass "100%" through npx\.cmd safely/);
  assert.throws(() => quoteWindowsShellArg('say "hi"'), /through npx\.cmd safely/);
});

test("runFlexcli runs the pinned FlexCLI through npx with the compat hook on Node.js 22+", () => {
  const { calls, spawnFn } = fakeSpawn(() => ({ status: 3 }));
  const status = runFlexcli(["plugin", "validate", "--path", "x.plugin"], { npm_execpath: "/opt/npm/bin/npm-cli.js", NODE_OPTIONS: "--trace-warnings" }, {
    ...POSIX,
    nodeVersion: "22.22.0",
    exists: (file) => file === "/opt/npm/bin/npx-cli.js",
    spawn: spawnFn,
    cwd: "/repo",
  });

  assert.equal(status, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/local/bin/node");
  assert.deepEqual(calls[0].args, ["/opt/npm/bin/npx-cli.js", "--yes", DEFAULT_FLEXCLI_SPEC, "plugin", "validate", "--path", "x.plugin"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(calls[0].options.stdio, "inherit");
  assert.match(calls[0].options.env.NODE_OPTIONS, /^--trace-warnings --import=file:\/\/.*\/scripts\/flexcli-compat\.mjs$/);

  const old = fakeSpawn();
  runFlexcli(["plugin", "list"], { FLEXCLI_SPEC: "@eniac/flexcli@1.0.8" }, { ...POSIX, spawn: old.spawnFn });
  assert.deepEqual(old.calls[0].args, ["--yes", "@eniac/flexcli@1.0.8", "plugin", "list"]);
  assert.equal(old.calls[0].command, "npx");
  assert.equal(old.calls[0].options.env.NODE_OPTIONS, undefined);
});

test("runFlexcli quotes arguments for the npx.cmd fallback on Windows", () => {
  const { calls, spawnFn } = fakeSpawn();
  const status = runFlexcli(["plugin", "install", "--path", "C:\\Users\\Jane Doe\\demo.flexplugin", "--force"], {}, {
    ...POSIX,
    platform: "win32",
    execPath: "C:\\nvm\\node.exe",
    spawn: spawnFn,
  });

  assert.equal(status, 0);
  assert.equal(calls[0].command, "npx.cmd");
  assert.equal(calls[0].options.shell, true);
  assert.deepEqual(calls[0].args, ["--yes", DEFAULT_FLEXCLI_SPEC, "plugin", "install", "--path", '"C:\\Users\\Jane Doe\\demo.flexplugin"', "--force"]);

  const unsafe = fakeSpawn();
  const messages = [];
  assert.equal(
    runFlexcli(["plugin", "pack", "--path", "C:\\100%\\x.plugin"], {}, { ...POSIX, platform: "win32", spawn: unsafe.spawnFn, log: (m) => messages.push(m) }),
    1
  );
  assert.equal(unsafe.calls.length, 0);
  assert.match(messages.join("\n"), /through npx\.cmd safely/);
});

test("runFlexcli reports a missing npx and a child killed by a signal as failures", () => {
  const messages = [];
  const missing = fakeSpawn(() => ({ error: new Error("spawn npx ENOENT"), status: null }));
  assert.equal(runFlexcli(["plugin", "list"], {}, { ...POSIX, spawn: missing.spawnFn, log: (m) => messages.push(m) }), 1);
  assert.match(messages.join("\n"), /Failed to start npx: spawn npx ENOENT/);

  const killed = fakeSpawn(() => ({ status: null, signal: "SIGTERM" }));
  assert.equal(runFlexcli(["plugin", "list"], {}, { ...POSIX, spawn: killed.spawnFn }), 1);
});

test("packPluginDir finds the folder of `plugin pack` only", () => {
  assert.equal(packPluginDir(PACK, "/repo"), path.resolve("/repo", "com.example.demo.plugin"));
  assert.equal(packPluginDir(["plugin", "pack", "--path=/abs/x.plugin"], "/repo"), path.resolve("/abs/x.plugin"));
  assert.equal(packPluginDir(["--port", "60109", "plugin", "pack", "--skip-validate", "--path", "y.plugin"], "/repo"), path.resolve("/repo", "y.plugin"));
  assert.equal(packPluginDir(["plugin", "validate", "--path", "x.plugin"], "/repo"), null);
  assert.equal(packPluginDir(["plugin", "install", "--path", "./x.flexplugin"], "/repo"), null);
  assert.equal(packPluginDir(["plugin", "pack"], "/repo"), null);
  assert.equal(
    configBackupPath("/repo/com.example.demo.plugin"),
    path.join(path.resolve("/repo"), ".com.example.demo.plugin.config.json.pack-backup")
  );
});

test("plugin pack moves config.json out of the plugin folder and restores it afterwards", (t) => {
  const workspace = makeWorkspace(t, { config: '{"codexHome":"/Users/me/.codex"}' });
  const seen = [];
  const { calls, spawnFn } = fakeSpawn(() => {
    seen.push({ config: fs.existsSync(workspace.configPath), backup: fs.existsSync(workspace.backupPath) });
    return { status: 0 };
  });

  assert.equal(runFlexcli(PACK, {}, { ...POSIX, spawn: spawnFn, cwd: workspace.root }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(seen, [{ config: false, backup: true }]);
  assert.equal(fs.readFileSync(workspace.configPath, "utf8"), '{"codexHome":"/Users/me/.codex"}');
  assert.equal(fs.existsSync(workspace.backupPath), false);

  // Other commands leave config.json alone.
  const other = fakeSpawn(() => {
    assert.equal(fs.existsSync(workspace.configPath), true);
    return { status: 0 };
  });
  runFlexcli(["plugin", "validate", "--path", "com.example.demo.plugin"], {}, { ...POSIX, spawn: other.spawnFn, cwd: workspace.root });
  assert.equal(other.calls.length, 1);
});

test("plugin pack restores config.json when FlexCLI fails or the spawn throws", (t) => {
  const workspace = makeWorkspace(t, { config: "{}" });
  const failing = fakeSpawn(() => ({ status: 1 }));
  assert.equal(runFlexcli(PACK, {}, { ...POSIX, spawn: failing.spawnFn, cwd: workspace.root }), 1);
  assert.equal(fs.existsSync(workspace.configPath), true);
  assert.equal(fs.existsSync(workspace.backupPath), false);

  const throwing = fakeSpawn(() => {
    assert.equal(fs.existsSync(workspace.configPath), false);
    throw new Error("boom");
  });
  assert.throws(() => runFlexcli(PACK, {}, { ...POSIX, spawn: throwing.spawnFn, cwd: workspace.root }), /boom/);
  assert.equal(fs.existsSync(workspace.configPath), true);
  assert.equal(fs.existsSync(workspace.backupPath), false);
});

test("plugin pack recovers a backup stranded by an interrupted pack and never overwrites", (t) => {
  const workspace = makeWorkspace(t);
  fs.writeFileSync(workspace.backupPath, '{"stranded":true}');
  const seen = [];
  const { spawnFn } = fakeSpawn(() => {
    seen.push(fs.existsSync(workspace.configPath));
    return { status: 0 };
  });
  assert.equal(runFlexcli(PACK, {}, { ...POSIX, spawn: spawnFn, cwd: workspace.root }), 0);
  assert.deepEqual(seen, [false]);
  assert.equal(fs.readFileSync(workspace.configPath, "utf8"), '{"stranded":true}');
  assert.equal(fs.existsSync(workspace.backupPath), false);

  // Both a backup and a newer config.json: refuse instead of guessing which one to keep.
  fs.writeFileSync(workspace.backupPath, '{"older":true}');
  const messages = [];
  const refused = fakeSpawn();
  assert.equal(runFlexcli(PACK, {}, { ...POSIX, spawn: refused.spawnFn, cwd: workspace.root, log: (m) => messages.push(m) }), 1);
  assert.equal(refused.calls.length, 0);
  assert.match(messages.join("\n"), /both exist\. Keep one of them/);
  assert.equal(fs.readFileSync(workspace.configPath, "utf8"), '{"stranded":true}');
  assert.equal(fs.readFileSync(workspace.backupPath, "utf8"), '{"older":true}');
});

test("setConfigJsonAside keeps a config.json re-created during the pack", (t) => {
  const workspace = makeWorkspace(t, { config: '{"before":true}' });
  const messages = [];
  const restore = setConfigJsonAside(workspace.pluginDir, (m) => messages.push(m));
  fs.writeFileSync(workspace.configPath, '{"during":true}');
  restore();
  restore();
  assert.equal(fs.readFileSync(workspace.configPath, "utf8"), '{"during":true}');
  assert.equal(fs.readFileSync(workspace.backupPath, "utf8"), '{"before":true}');
  assert.match(messages.join("\n"), /re-created while packing/);

  const empty = makeWorkspace(t);
  const noop = setConfigJsonAside(empty.pluginDir);
  noop();
  assert.equal(fs.existsSync(empty.configPath), false);
  assert.equal(fs.existsSync(empty.backupPath), false);
});

// End to end through the real wrapper process: npm_execpath points at a fake npm whose npx-cli.js stands in for
// FlexCLI, writes what it saw and keeps running until the wrapper has been sent SIGTERM.
test("an interrupted `plugin pack` still puts config.json back", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeWorkspace(t, { config: '{"keep":"me"}' });
  const binDir = path.join(workspace.root, "fake-npm");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "npm-cli.js"), "");
  const seenFile = path.join(workspace.root, "seen.json");
  fs.writeFileSync(
    path.join(binDir, "npx-cli.js"),
    `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const dir = path.resolve(args[args.indexOf("--path") + 1]);
fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ args, config: fs.existsSync(path.join(dir, "config.json")) }));
setTimeout(() => process.exit(0), 1500);
`
  );

  const env = { ...process.env, npm_execpath: path.join(binDir, "npm-cli.js") };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [wrapperPath, ...PACK], { cwd: workspace.root, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(seenFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(seenFile), `fake FlexCLI never ran: ${stderr}`);
  const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
  assert.deepEqual(seen.args.slice(0, 2), ["--yes", DEFAULT_FLEXCLI_SPEC]);
  assert.equal(seen.config, false, "config.json must not be in the folder FlexCLI packs");
  assert.equal(fs.existsSync(workspace.configPath), false);

  child.kill("SIGTERM");
  const { signal } = await exited;
  assert.equal(signal, "SIGTERM");
  assert.equal(fs.readFileSync(workspace.configPath, "utf8"), '{"keep":"me"}');
  assert.equal(fs.existsSync(workspace.backupPath), false);
});

test("package.json runs every FlexCLI command through the wrapper with the manifest uuid", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "com.aspen.flexbar-ai-dashboard.plugin", "manifest.json"), "utf8"));
  // Scripts chain steps with &&; check every step that invokes FlexCLI.
  const flexcliSteps = Object.entries(pkg.scripts).flatMap(([name, command]) =>
    command.split("&&").map((step) => [name, step.trim()]).filter(([, step]) => /\bflexcli\b/.test(step))
  );

  assert.ok(flexcliSteps.length >= 7);
  for (const [name, step] of flexcliSteps) {
    assert.match(step, /^node scripts\/flexcli\.cjs plugin /, `${name} must use scripts/flexcli.cjs`);
    for (const [, uuid] of step.matchAll(/--uuid[= ](\S+)/g)) {
      assert.equal(uuid, manifest.uuid, `${name} uses the wrong uuid`);
    }
    for (const [, target] of step.matchAll(/--path (\S+)/g)) {
      assert.ok(
        target === `${manifest.uuid}.plugin` || target === `./${manifest.uuid}.flexplugin`,
        `${name} points --path at ${target}`
      );
    }
  }
});

test("pack, install and dev chain build and doctor explicitly (no npm pre-hooks)", () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.equal(scripts.doctor, "node scripts/doctor.cjs");
  // Explicit chaining also works with `npm --ignore-scripts`, pnpm and yarn, which skip pre-hooks.
  assert.equal(
    scripts["plugin:pack"],
    "npm run build && npm run doctor && node scripts/flexcli.cjs plugin pack --path com.aspen.flexbar-ai-dashboard.plugin"
  );
  assert.equal(
    scripts["plugin:install"],
    "npm run plugin:pack && node scripts/flexcli.cjs plugin install --path ./com.aspen.flexbar-ai-dashboard.flexplugin --force"
  );
  assert.match(scripts.dev, /^npm run build && npm run doctor && npm-run-all /);
  for (const name of Object.keys(scripts)) {
    assert.ok(!/^(pre|post)(plugin:|dev$|build$)/.test(name), `${name} would run build/doctor twice`);
  }
});
