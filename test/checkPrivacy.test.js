"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatFinding,
  globToRegExp,
  loadDenylist,
  maskSecret,
  parseAllowlist,
  parseArgs,
  parsePrePushLines,
  scanCommitMeta,
  scanPatch,
  scanPathName,
  scanText,
} = require("../scripts/check-privacy.cjs");

const repoRoot = path.join(__dirname, "..");
const SCRIPT = path.join(repoRoot, "scripts", "check-privacy.cjs");

// Fake values, assembled at runtime so that this file never contains a match itself.
const GITHUB_TOKEN = "gh" + "p_" + "A".repeat(36);
const FINE_GRAINED_PAT = "github" + "_pat_" + "11ABCDEFG0" + "a".repeat(20);
const ANTHROPIC_KEY = "sk-" + "ant-" + "api03-" + "a1B2".repeat(10);
const OPENAI_KEY = "sk-" + "proj-" + "a1B2c3".repeat(5);
const AWS_KEY = "AK" + "IA" + "ABCDEFGHIJ234567";
const SLACK_TOKEN = "xo" + "xb-" + "1234567890-abcdefghij";
const GOOGLE_KEY = "AI" + "za" + "Sy" + "A".repeat(33);
const JWT = "ey" + "JhbGciOiJIUzI1NiJ9" + ".ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0" + ".c2lnbmF0dXJl";
const PEM_HEADER = "-----BEGIN " + "RSA PRIVATE KEY-----";
const RANDOM_VALUE = "Zx81kQ0pLm2Nv7Rt";
const PERSONAL_EMAIL = ["alice", "mail.com"].join("@");
const FAKE_SERIAL = "9F21" + "C04D7E15";
const NOREPLY = "12345678+octo@users.noreply.github.com";
const ZEROS = "0".repeat(40);

function detectors(findings) {
  return findings.map((finding) => finding.detector);
}

function tempDir(t, prefix = "check-privacy-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("token detectors flag known secret formats and mask them", () => {
  const cases = [
    ["github-token", `GITHUB=${GITHUB_TOKEN}`, GITHUB_TOKEN],
    ["github-token", `pat ${FINE_GRAINED_PAT}`, FINE_GRAINED_PAT],
    ["anthropic-key", `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`, ANTHROPIC_KEY],
    ["openai-key", `OPENAI=${OPENAI_KEY}`, OPENAI_KEY],
    ["aws-access-key", `aws ${AWS_KEY}`, AWS_KEY],
    ["slack-token", `slack ${SLACK_TOKEN}`, SLACK_TOKEN],
    ["google-api-key", `key ${GOOGLE_KEY}`, GOOGLE_KEY],
    ["jwt", `cookie=${JWT}`, JWT],
    ["private-key", PEM_HEADER, null],
  ];
  for (const [detector, line, secret] of cases) {
    const findings = scanText(line, { path: "a.txt" });
    assert.deepEqual(detectors(findings), [detector], line);
    if (secret) {
      assert.ok(!findings[0].snippet.includes(secret), `${detector} snippet is masked`);
      assert.ok(!formatFinding(findings[0]).includes(secret), `${detector} report is masked`);
    }
  }
});

test("token detectors ignore look-alikes", () => {
  for (const line of [
    "const risk-assessment = 1",
    "sk-" + "some-long-kebab-case-identifier",
    "ghp_short",
    "eyJhbGciOiJIUzI1NiJ9 without a payload",
    "-----BEGIN PUBLIC KEY-----",
  ]) {
    assert.deepEqual(scanText(line), [], line);
  }
});

test("bearer and generic secret assignments flag literal values only", () => {
  const bearer = scanText("Authorization: Bear" + "er " + "abc123XYZ".repeat(3));
  assert.deepEqual(detectors(bearer), ["bearer-token"]);
  assert.match(bearer[0].snippet, /^Bearer ab…/);

  const quoted = '"' + RANDOM_VALUE + '"';
  for (const line of [`api_key = ${quoted}`, `"client_secret": ${quoted}`, `GITHUB_TOKEN=${quoted}`, `password: ${quoted}`]) {
    const findings = scanText(line);
    assert.deepEqual(detectors(findings), ["generic-secret"], line);
    assert.ok(!findings[0].snippet.includes(RANDOM_VALUE));
  }

  for (const line of [
    "Authorization: Bearer ${token}",
    'headers.Authorization = "Bearer " + token',
    'password: "your-password-here1"',
    'token: "${GITHUB_TOKEN_VALUE}"',
    'api_key = "<your api key 123>"',
    'secret: "aaaaaaaaaaaaaaaa"',
    'tokenUsage: "' + RANDOM_VALUE + '"',
    'token = "https://example.com/a1b2c3d4"',
    'max_tokens: "' + RANDOM_VALUE + '"',
  ]) {
    assert.deepEqual(scanText(line), [], line);
  }
});

test("personal absolute paths are flagged unless the name is a placeholder", () => {
  const unixPath = "/Us" + "ers/alice/projects/app";
  const linuxPath = "/ho" + "me/bob/.config";
  const windowsPath = "C:\\Us" + "ers\\carol\\AppData";
  const escapedWindowsPath = "C:\\\\Us" + "ers\\\\dave\\\\.codex";
  for (const line of [unixPath, linuxPath, windowsPath, escapedWindowsPath, "file:///Us" + "ers/erin/x"]) {
    assert.deepEqual(detectors(scanText(line)), ["personal-path"], line);
  }
  assert.equal(scanText(unixPath)[0].snippet, "/Users/al…");

  for (const line of [
    "/Users/me/workspace",
    "/Users/you/.codex",
    "/Users/Shared/data",
    "/Users/Jane Doe/Desktop",
    "/home/runner/work/repo",
    "/home/user/.claude",
    "C:\\Users\\Public\\x",
    "C:\\Users\\%USERNAME%\\.codex",
    "C:\\Users\\<you>\\.codex",
    "/Users/$USER/x",
    "/Users/${name}/x",
    "$HOME/.codex",
    "~/Library/Application Support",
    "https://example.com/home/page",
    "/Users/…",
    "/Users/al…/masked",
  ]) {
    assert.deepEqual(scanText(line), [], line);
  }
});

test("emails are flagged unless noreply, reserved example domains or file names", () => {
  const findings = scanText(`contact ${PERSONAL_EMAIL}`);
  assert.deepEqual(detectors(findings), ["email"]);
  assert.equal(findings[0].snippet, "al…@ma…");

  for (const line of [
    NOREPLY,
    "noreply@github.com",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "dev@example.com",
    "ops@mail.example.org",
    "someone@host.test",
    "icon@2x.png",
    "git@github.com:owner/repo.git",
    "@napi-rs/canvas@0.1.80",
  ]) {
    assert.deepEqual(scanText(line), [], line);
  }
});

test("device serial numbers are flagged in a serial/device/Flexbar context, placeholders are not", () => {
  const findings = scanText(`const serialNumber = "${FAKE_SERIAL}";`);
  assert.deepEqual(detectors(findings), ["device-serial"]);
  assert.equal(findings[0].snippet, "9F…");
  assert.deepEqual(detectors(scanPathName(`assets/Flexbar-${FAKE_SERIAL}-shot.jpg`)), ["device-serial"]);

  assert.deepEqual(scanText('const REAL_SERIAL = "001100AA0001"; // placeholder'), []);
  assert.deepEqual(scanText(`hash ${FAKE_SERIAL}`), [], "no serial context");
  assert.deepEqual(scanText(`serial ${FAKE_SERIAL.toLowerCase()}`), [], "lower-case hex is a hash");
});

test("privacy-allow skips the pattern detectors but never the denylist", () => {
  assert.deepEqual(scanText(`GITHUB=${GITHUB_TOKEN} // privacy-allow: test fixture`), []);
  const findings = scanText("quokkafan42 // privacy-allow", { denylist: ["quokkafan42"] });
  assert.deepEqual(detectors(findings), ["denylist"]);
});

test("maskSecret keeps a known prefix and two characters", () => {
  assert.equal(maskSecret(GITHUB_TOKEN), "ghp_AA…(40 chars)");
  assert.equal(maskSecret(AWS_KEY), "AKIAAB…(20 chars)");
  assert.equal(maskSecret(RANDOM_VALUE), "Zx…(16 chars)");
});

test("loadDenylist reads literals, skips comments and never reports a term", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "denylist");
  fs.writeFileSync(file, "# my identifiers\n\n  QuokkaFan42  \nab\nquokkafan42\r\nSecond Term\n", "utf8");
  const warnings = [];
  const denylist = loadDenylist([file, path.join(dir, "missing")], { onWarning: (message) => warnings.push(message) });
  assert.deepEqual(denylist, ["quokkafan42", "second term"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /denylist:4: entry ignored/);
  assert.ok(!warnings[0].includes("ab\n"));

  const findings = scanText("hello\nwritten by QUOKKAFAN42 and second TERM", { path: "notes.md", denylist });
  assert.deepEqual(
    findings.map(formatFinding),
    ["notes.md:2 [denylist] QU…", "notes.md:2 [denylist] se…"],
  );

  const named = scanPathName("docs/quokkafan42-notes.md", { denylist });
  assert.deepEqual(named.map(formatFinding), ["docs/qu…-notes.md [denylist] qu… (in file name)"]);
});

test("allowlist entries need a matching detector, path glob and literal", () => {
  const allowlist = parseAllowlist(`# upstream screenshot\ndevice-serial assets/*.jpg ${FAKE_SERIAL}\n* docs/** \n`);
  assert.deepEqual(scanPathName(`assets/Flexbar-${FAKE_SERIAL}-shot.jpg`, { allowlist }), []);
  assert.equal(scanPathName(`img/Flexbar-${FAKE_SERIAL}-shot.jpg`, { allowlist }).length, 1);
  assert.deepEqual(scanText(`contact ${PERSONAL_EMAIL}`, { path: "docs/a/b.md", allowlist }), []);
  assert.equal(scanText(`contact ${PERSONAL_EMAIL}`, { path: "src/b.md", allowlist }).length, 1);
  assert.deepEqual(detectors(scanText("quokkafan42", { path: "docs/x.md", allowlist, denylist: ["quokkafan42"] })), ["denylist"]);

  assert.ok(globToRegExp("src/**/x.js").test("src/x.js"));
  assert.ok(globToRegExp("src/**/x.js").test("src/a/b/x.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/a/x.js"));
  assert.throws(() => parseAllowlist("onlyonefield\n"), /expected/);
});

test("commit metadata must use GitHub noreply emails and pass the content scan", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(scanCommitMeta({ sha, authorEmail: NOREPLY, committerEmail: "noreply@github.com", message: "fix: x\n" }), []);
  assert.deepEqual(
    scanCommitMeta({ sha, authorEmail: "41898282+github-actions[bot]@users.noreply.github.com", committerEmail: "octo@users.noreply.github.com" }),
    [],
  );

  const findings = scanCommitMeta(
    {
      sha,
      authorName: "Quokka Fan",
      authorEmail: PERSONAL_EMAIL,
      committerName: "Octo",
      committerEmail: NOREPLY,
      message: `feat: add key\n\ntoken ${GITHUB_TOKEN}\n`,
    },
    { denylist: ["quokka fan"] },
  );
  assert.deepEqual(findings.map(formatFinding), [
    "commit aaaaaaaaaaaa [author-email] al…@ma…",
    "commit aaaaaaaaaaaa [denylist] author name: Qu…",
    "commit aaaaaaaaaaaa message:3 [github-token] ghp_AA…(40 chars)",
  ]);
});

test("parsePrePushLines maps each pushed ref to the commits it publishes", () => {
  const local = "1".repeat(40);
  const remote = "2".repeat(40);
  const updates = parsePrePushLines(
    [
      `refs/heads/main ${local} refs/heads/main ${remote}`,
      `refs/heads/feature ${local} refs/heads/feature ${ZEROS}`,
      `(delete) ${ZEROS} refs/heads/old ${remote}`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(updates.map((update) => update.revArgs), [[`${remote}..${local}`], [local, "--not", "--remotes"], null]);
  assert.deepEqual(updates.map((update) => update.deleted), [false, false, true]);
  assert.deepEqual(parsePrePushLines(""), []);
  assert.throws(() => parsePrePushLines("refs/heads/main abc refs/heads/main def"), /unexpected pre-push input/);
});

test("parseArgs defaults to tracked files plus unpushed commits and rejects unsafe range options", () => {
  assert.deepEqual(parseArgs([]), { tracked: true, staged: false, prePush: false, unpushed: true, ranges: [], help: false });
  assert.deepEqual(parseArgs(["--range", "HEAD --not --remotes"]).ranges, [["HEAD", "--not", "--remotes"]]);
  assert.deepEqual(parseArgs(["--range=main..HEAD", "--staged"]).ranges, [["main..HEAD"]]);
  assert.throws(() => parseArgs(["--range", "--output=/tmp/x"]), /unsupported option/);
  assert.throws(() => parseArgs(["--range"]), /needs a revision range/);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("scanPatch reports added lines with their new line numbers, including merge resolutions", () => {
  const patch = [
    "\x01" + "c".repeat(40),
    "",
    "diff --git a/src/a.js b/src/a.js",
    "index 1111111..2222222 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -10,2 +10,0 @@ function x() {",
    `-old ${GITHUB_TOKEN}`,
    "-old line",
    "@@ -20,0 +18,2 @@",
    "+fine line",
    `+new ${GITHUB_TOKEN}`,
    "diff --git a/.privacy-allowlist b/.privacy-allowlist",
    "--- a/.privacy-allowlist",
    "+++ b/.privacy-allowlist",
    "@@ -1,0 +2 @@",
    `+device-serial README.md ${FAKE_SERIAL}`,
    "\x01" + "d".repeat(40),
    "",
    "diff --cc src/b.js",
    "--- a/src/b.js",
    "+++ b/src/b.js",
    "@@@ -1,1 -1,1 +1,3 @@@",
    `++evil ${PERSONAL_EMAIL}`,
    ` +from second parent ${AWS_KEY}`,
    `- removed ${SLACK_TOKEN}`,
    "++last",
    "\\ No newline at end of file",
  ].join("\n");
  const findings = scanPatch(patch, { denylist: ["quokkafan42"] });
  assert.deepEqual(findings.map(formatFinding), [
    "src/a.js:19 [github-token] ghp_AA…(40 chars) (commit cccccccccccc)",
    "src/b.js:1 [email] al…@ma… (commit dddddddddddd)",
  ]);
});

// --- end to end, in a throwaway repository -----------------------------------------------------------------------

function childEnv(extra = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
    "PRIVACY_DENYLIST_FILE",
    "PRIVACY_UPSTREAM_REFS",
    "PRIVACY_PUBLISHED_REFS",
  ]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function makeRepo(t) {
  const repo = tempDir(t, "check-privacy-repo-");
  const env = childEnv({
    GIT_AUTHOR_NAME: "Octo",
    GIT_AUTHOR_EMAIL: NOREPLY,
    GIT_COMMITTER_NAME: "Octo",
    GIT_COMMITTER_EMAIL: NOREPLY,
  });
  const git = (args, extraEnv = {}) => {
    const result = spawnSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/hooks", "-c", "init.defaultBranch=main", ...args],
      { cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (file, content, message, extraEnv) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content, "utf8");
    git(["add", "--", file]);
    git(["commit", "-q", "-m", message], extraEnv);
    return git(["rev-parse", "HEAD"]);
  };
  const check = (args, { input = "", env: extraEnv = {} } = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, env: childEnv(extraEnv), input, encoding: "utf8" });
  git(["init", "-q"]);
  return { repo, git, commit, check };
}

test("--range still flags a token removed by a later commit; --tracked does not", (t) => {
  const { commit, check } = makeRepo(t);
  commit("README.md", "# demo\n", "docs: start");
  const leak = commit("config.txt", `name=demo\nGITHUB=${GITHUB_TOKEN}\n`, "feat: add config");
  commit("config.txt", "name=demo\nGITHUB=see your password manager\n", "fix: drop the token");

  const range = check(["--range", "HEAD"]);
  assert.equal(range.status, 1, range.stderr);
  assert.match(range.stdout, new RegExp(`config\\.txt:2 \\[github-token\\] ghp_AA…\\(40 chars\\) \\(commit ${leak.slice(0, 12)}\\)`));
  assert.ok(!range.stdout.includes(GITHUB_TOKEN), "the token itself is never printed");

  const tracked = check(["--tracked"]);
  assert.equal(tracked.status, 0, tracked.stdout + tracked.stderr);
  assert.match(tracked.stdout, /check-privacy: clean/);

  const defaults = check([]);
  assert.equal(defaults.status, 1, "no arguments scans the unpushed commits too");
});

test("--pre-push scans what each ref publishes and skips deletions", (t) => {
  const { commit, check } = makeRepo(t);
  const base = commit("a.txt", "clean\n", "chore: base");
  const head = commit("b.txt", `AWS=${AWS_KEY}\n`, "feat: leak");

  const newBranch = check(["--pre-push"], { input: `refs/heads/main ${head} refs/heads/main ${ZEROS}\n` });
  assert.equal(newBranch.status, 1);
  assert.match(newBranch.stdout, /b\.txt:1 \[aws-access-key\]/);
  assert.match(newBranch.stdout, /push blocked/);

  const update = check(["--pre-push"], { input: `refs/heads/main ${head} refs/heads/main ${base}\n` });
  assert.equal(update.status, 1);

  const upToDate = check(["--pre-push"], { input: `refs/heads/main ${head} refs/heads/main ${head}\n` });
  assert.equal(upToDate.status, 0, upToDate.stdout);

  const deletion = check(["--pre-push"], { input: `(delete) ${ZEROS} refs/heads/old ${head}\n` });
  assert.equal(deletion.status, 0, deletion.stdout);

  const garbage = check(["--pre-push"], { input: "not a pre-push line\n" });
  assert.equal(garbage.status, 2);
});

test("commit emails must be noreply unless upstream or origin/main already has the commit", (t) => {
  const { git, commit, check } = makeRepo(t);
  const upstreamCommit = commit("up.txt", `contact ${PERSONAL_EMAIL}\n`, "upstream work", { GIT_AUTHOR_EMAIL: "dev@example.com" });
  git(["update-ref", "refs/remotes/upstream/main", upstreamCommit]);
  const mine = commit("mine.txt", "ok\n", "feat: mine", { GIT_AUTHOR_EMAIL: "dev@example.com" });

  const result = check(["--range", "HEAD"]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.split("\n").filter((line) => line.includes("[")), [
    `commit ${mine.slice(0, 12)} [author-email] de…@ex…`,
  ]);

  git(["update-ref", "refs/remotes/origin/main", mine]);
  const published = check(["--range", "HEAD"]);
  assert.equal(published.status, 0, published.stdout);

  const strict = check(["--range", "HEAD"], { env: { PRIVACY_PUBLISHED_REFS: "", PRIVACY_UPSTREAM_REFS: "" } });
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /up\.txt:1 \[email\]/);
  assert.match(strict.stdout, new RegExp(`commit ${upstreamCommit.slice(0, 12)} \\[author-email\\]`));
});

test("the local denylist in .git/info is applied without echoing its terms", (t) => {
  const { repo, git, commit, check } = makeRepo(t);
  const term = "quokka" + "fan42";
  const denylistFile = path.resolve(repo, git(["rev-parse", "--git-path", "info/privacy-denylist"]));
  fs.mkdirSync(path.dirname(denylistFile), { recursive: true });
  fs.writeFileSync(denylistFile, `# local only\n${term}\n`, "utf8");
  commit("notes.md", `# notes\nwritten by ${term.toUpperCase()}\n`, "docs: notes");
  commit(`${term}.txt`, "x\n", "chore: named file");

  const tracked = check(["--tracked"]);
  assert.equal(tracked.status, 1);
  assert.match(tracked.stdout, /notes\.md:2 \[denylist\] QU…/);
  assert.match(tracked.stdout, /qu…\.txt \[denylist\] qu… \(in file name\)/);
  assert.ok(!tracked.stdout.toLowerCase().includes(term), "the denylist term is never printed");

  const extra = path.join(repo, "..", `${path.basename(repo)}-extra-denylist`);
  fs.writeFileSync(extra, "written by\n", "utf8");
  t.after(() => fs.rmSync(extra, { force: true }));
  const withExtra = check(["--range", "HEAD"], { env: { PRIVACY_DENYLIST_FILE: extra } });
  assert.match(withExtra.stdout, /notes\.md:2 \[denylist\] wr…/);
});

test("usage and git errors exit with 2", (t) => {
  const { commit, check } = makeRepo(t);
  commit("a.txt", "x\n", "chore: a");
  assert.equal(check(["--bogus"]).status, 2);
  const badRange = check(["--range", "nope..HEAD"]);
  assert.equal(badRange.status, 2);
  assert.match(badRange.stderr, /check-privacy: git .*failed/);
  assert.equal(check(["--help"]).status, 0);
});

test("the pre-push hook and npm scripts run the privacy check", () => {
  const hook = fs.readFileSync(path.join(repoRoot, ".githooks", "pre-push"), "utf8");
  assert.match(hook, /^#!\/bin\/sh\n/);
  assert.match(hook, /node "\$root\/scripts\/check-privacy\.cjs" --pre-push/);
  const index = spawnSync("git", ["ls-files", "-s", "--", ".githooks/pre-push"], { cwd: repoRoot, env: childEnv(), encoding: "utf8" });
  if (index.status === 0 && index.stdout.trim()) assert.match(index.stdout, /^100755 /, "the hook is executable in git");

  const { scripts } = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(scripts["check:privacy"], "node scripts/check-privacy.cjs");
  assert.equal(scripts["hooks:install"], "git config core.hooksPath .githooks");
});
