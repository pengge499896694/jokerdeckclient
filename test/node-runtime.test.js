const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { corePath } = require("../src/node-runtime");

test("resolves each packaged proxy core from app resources", () => {
  assert.equal(corePath("/app/resources", true, "darwin", "arm64"), path.join("/app/resources", "core", "arm64", "mihomo"));
  assert.equal(corePath("C:\\resources", true, "win32", "x64"), path.join("C:\\resources", "core", "x64", "mihomo.exe"));
});
