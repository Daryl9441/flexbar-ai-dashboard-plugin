"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listAiSkills } = require("../src/collectors/skills");

test("skill collector lists Codex skills from CODEX_HOME", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skills-codex-"));
  const skillDir = path.join(home, ".codex", "skills", "diagnose");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: diagnose",
    "description: Debug failures systematically",
    "---",
    "",
    "# Diagnose",
  ].join("\n"), "utf8");

  const skills = listAiSkills({
    env: { USERPROFILE: home, HOME: home },
  });

  assert.deepEqual(skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
  })), [
    {
      name: "diagnose",
      description: "Debug failures systematically",
    },
  ]);
});
