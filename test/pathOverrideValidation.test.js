"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { validatePathOverrides } = require("../src/collectors/pathOverrideValidation");

test("validatePathOverrides accepts empty overrides", () => {
  assert.deepEqual(validatePathOverrides({ pathOverrides: {} }), { ok: true });
});

test("validatePathOverrides requires existing Codex home directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-codex-"));
  const missing = path.join(tempDir, "missing-codex");

  assert.deepEqual(
    validatePathOverrides({ pathOverrides: { CODEX_HOME: missing } }),
    {
      ok: false,
      errors: [{
        key: "CODEX_HOME",
        message: `Codex home does not exist: ${missing}`,
      }],
    }
  );

  fs.mkdirSync(missing, { recursive: true });
  assert.deepEqual(
    validatePathOverrides({ pathOverrides: { CODEX_HOME: missing } }),
    { ok: true }
  );
});

test("validatePathOverrides rejects Codex home when path is a file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-codex-file-"));
  const filePath = path.join(tempDir, "not-a-dir");
  fs.writeFileSync(filePath, "", "utf8");

  const result = validatePathOverrides({ pathOverrides: { CODEX_HOME: filePath } });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /must be a directory/);
});
