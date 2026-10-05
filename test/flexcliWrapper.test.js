"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildNodeOptions,
  isFlexcliModuleUrl,
  needsImportAssertionCompat,
  rewriteImportAssertions,
} = require("../scripts/flexcli.cjs");

const repoRoot = path.join(__dirname, "..");

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

test("compat hook lets FlexCLI-style import assertions load on this Node.js", { skip: !needsImportAssertionCompat() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flexcli-compat-"));
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

test("package.json runs every FlexCLI command through the wrapper with the manifest uuid", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "com.aspen.flexbar-ai-dashboard.plugin", "manifest.json"), "utf8"));
  const flexcliScripts = Object.entries(pkg.scripts).filter(([, command]) => /\bflexcli\b/.test(command));

  assert.ok(flexcliScripts.length >= 7);
  for (const [name, command] of flexcliScripts) {
    assert.match(command, /^node scripts\/flexcli\.cjs plugin /, `${name} must use scripts/flexcli.cjs`);
    for (const [, uuid] of command.matchAll(/--uuid[= ](\S+)/g)) {
      assert.equal(uuid, manifest.uuid, `${name} uses the wrong uuid`);
    }
    for (const [, target] of command.matchAll(/--path (\S+)/g)) {
      assert.ok(
        target === `${manifest.uuid}.plugin` || target === `./${manifest.uuid}.flexplugin`,
        `${name} points --path at ${target}`
      );
    }
  }
});

test("pack and install build and run the doctor first", () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.equal(scripts.doctor, "node scripts/doctor.cjs");
  assert.equal(scripts["preplugin:pack"], "npm run build && npm run doctor");
  assert.equal(scripts["preplugin:install"], "npm run plugin:pack");
  assert.equal(scripts.predev, "npm run build && npm run doctor");
});
