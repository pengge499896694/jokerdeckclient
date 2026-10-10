const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseWindowsAppPath,
  parseWindowsCommandPaths,
  windowsCodexAppCandidates,
  windowsCodexCandidates,
  windowsCodexCliCandidates,
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

test("includes desktop application paths for proxied Windows launches", () => {
  const candidates = windowsCodexAppCandidates({
    LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  });
  assert.ok(candidates.includes("C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\Codex.exe"));
  assert.ok(candidates.includes("C:\\Users\\alice\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe"));
});

test("CLI detection excludes desktop executables and prefers native EXEs to command shims", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
  };
  const desktop = "C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\Codex.exe";
  const command = "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd";
  const native = "C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  const candidates = windowsCodexCliCandidates([command, desktop, native], env);
  assert.ok(!candidates.includes(desktop));
  assert.ok(candidates.indexOf(native) < candidates.indexOf(command));
});

test("parses where.exe and App Paths output", () => {
  assert.deepEqual(parseWindowsCommandPaths("C:\\Tools\\codex.exe\r\nINFO: no files found"), ["C:\\Tools\\codex.exe"]);
  assert.deepEqual(parseWindowsAppPath("    (Default)    REG_SZ    C:\\Tools\\codex.exe"), ["C:\\Tools\\codex.exe"]);
});
