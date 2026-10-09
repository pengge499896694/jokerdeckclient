const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseWindowsAppPath,
  parseWindowsCommandPaths,
  windowsCodexCandidates,
} = require("../src/codex-detection");

test("includes the official standalone Windows Codex CLI path", () => {
  const candidates = windowsCodexCandidates({
    LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    USERPROFILE: "C:\\Users\\alice",
  });
  assert.ok(candidates.includes("C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe"));
  assert.ok(candidates.includes("C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd"));
});

test("parses where.exe and App Paths output", () => {
  assert.deepEqual(parseWindowsCommandPaths("C:\\Tools\\codex.exe\r\nINFO: no files found"), ["C:\\Tools\\codex.exe"]);
  assert.deepEqual(parseWindowsAppPath("    (Default)    REG_SZ    C:\\Tools\\codex.exe"), ["C:\\Tools\\codex.exe"]);
});
