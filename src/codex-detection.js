const path = require("node:path");

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function windowsCodexCandidates(env = process.env) {
  const join = path.win32.join;
  const localAppData = env.LOCALAPPDATA || "";
  const appData = env.APPDATA || "";
  const programFiles = env.ProgramW6432 || env.ProgramFiles || "";
  const programFilesX86 = env["ProgramFiles(x86)"] || "";
  const userProfile = env.USERPROFILE || env.HOME || "";
  return unique([
    "codex.exe",
    "codex.cmd",
    join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    join(localAppData, "Programs", "OpenAI", "Codex", "codex.exe"),
    join(localAppData, "Programs", "OpenAI", "Codex", "Codex.exe"),
    join(localAppData, "Programs", "Codex", "bin", "codex.exe"),
    join(localAppData, "Programs", "Codex", "Codex.exe"),
    join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
    join(appData, "npm", "codex.cmd"),
    join(appData, "npm", "codex.exe"),
    join(programFiles, "OpenAI", "Codex", "bin", "codex.exe"),
    join(programFiles, "OpenAI", "Codex", "Codex.exe"),
    join(programFiles, "Codex", "bin", "codex.exe"),
    join(programFilesX86, "OpenAI", "Codex", "bin", "codex.exe"),
    join(programFilesX86, "OpenAI", "Codex", "Codex.exe"),
    join(programFilesX86, "Codex", "bin", "codex.exe"),
    join(userProfile, ".local", "bin", "codex.exe"),
  ]);
}

function windowsCodexAppCandidates(env = process.env) {
  const join = path.win32.join;
  const localAppData = env.LOCALAPPDATA || "";
  const programFiles = env.ProgramW6432 || env.ProgramFiles || "";
  const programFilesX86 = env["ProgramFiles(x86)"] || "";
  return unique([
    join(localAppData, "Programs", "OpenAI", "Codex", "Codex.exe"),
    join(localAppData, "Programs", "Codex", "Codex.exe"),
    join(localAppData, "Programs", "ChatGPT", "ChatGPT.exe"),
    join(localAppData, "ChatGPT", "ChatGPT.exe"),
    join(programFiles, "OpenAI", "Codex", "Codex.exe"),
    join(programFiles, "Codex", "Codex.exe"),
    join(programFiles, "ChatGPT", "ChatGPT.exe"),
    join(programFilesX86, "OpenAI", "Codex", "Codex.exe"),
    join(programFilesX86, "Codex", "Codex.exe"),
    join(programFilesX86, "ChatGPT", "ChatGPT.exe"),
  ]);
}

function windowsCodexCliCandidates(discovered = [], env = process.env) {
  const desktopApps = new Set(windowsCodexAppCandidates(env).map((candidate) => candidate.toLowerCase()));
  return unique([...discovered, ...windowsCodexCandidates(env)])
    .filter((candidate) => !desktopApps.has(candidate.toLowerCase()))
    .sort((left, right) => Number(/\.(?:cmd|bat)$/i.test(left)) - Number(/\.(?:cmd|bat)$/i.test(right)));
}

function parseWindowsCommandPaths(output) {
  return unique(
    String(output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^INFO:/i.test(line)),
  );
}

function parseWindowsAppPath(output) {
  return unique(
    String(output || "")
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
        return match ? match[1].trim().replace(/^"|"$/g, "") : "";
      })
      .filter((value) => value && /(?:codex(?:\.exe)?|\\codex\.exe)$/i.test(value)),
  );
}

module.exports = {
  parseWindowsAppPath,
  parseWindowsCommandPaths,
  unique,
  windowsCodexAppCandidates,
  windowsCodexCandidates,
  windowsCodexCliCandidates,
};
