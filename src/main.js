const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createWriteStream, createReadStream } = require("node:fs");
const os = require("node:os");
const { execFile, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const API_ORIGIN = "https://jokerdeck.de5.net/api/v1";
const SESSION_FILE = () => path.join(app.getPath("userData"), "session.json");
const UPDATE_URL = "https://jokerdeck.de5.net/client-site/switch-latest.json";
let mainWindow;
let transientSession = null;
const MCP_NAME = "jokerdeck-computer-use";

function helperRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "helpers")
    : path.join(__dirname, "..", "vendor", process.platform === "win32" ? "win" : "mac");
}

function localizationHelper() {
  if (process.platform === "win32")
    return path.join(helperRoot(), "Codex-Zh-Launcher.exe");
  return path.join(
    helperRoot(),
    process.arch === "arm64" ? "arm64" : "x64",
    "Codex 汉化增强工具.app",
    "Contents", "MacOS", "CodexZhLauncherMac",
  );
}

function computerUseHelper() {
  return process.platform === "win32"
    ? path.join(helperRoot(), "open-computer-use.exe")
    : path.join(helperRoot(), "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse");
}

async function fileExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function readSession() {
  if (transientSession) return transientSession;
  try {
    const raw = JSON.parse(await fs.readFile(SESSION_FILE(), "utf8"));
    if (raw.token)
      raw.token = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(raw.token, "base64"))
        : "";
    if (raw.refreshToken)
      raw.refreshToken = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(raw.refreshToken, "base64"))
        : "";
    return { rememberLogin: true, ...raw };
  } catch {
    return {
      token: "",
      user: null,
      selectedGroup: null,
      selectedEndpoint: null,
      setupDone: false,
      rememberLogin: true,
      integrations: { localization: true, computerUse: {} },
    };
  }
}

async function writeSession(session) {
  if (session.rememberLogin !== false && session.token && !safeStorage.isEncryptionAvailable())
    throw new Error("系统安全存储不可用，无法保存登录状态");
  transientSession = session;
  const copy = { ...session };
  if (copy.rememberLogin === false) {
    copy.token = "";
    copy.refreshToken = "";
    copy.expiresAt = 0;
    copy.user = null;
  } else {
    if (copy.token)
      copy.token = safeStorage.encryptString(copy.token).toString("base64");
    if (copy.refreshToken)
      copy.refreshToken = safeStorage.encryptString(copy.refreshToken).toString("base64");
  }
  await fs.mkdir(path.dirname(SESSION_FILE()), { recursive: true });
  await fs.writeFile(SESSION_FILE(), JSON.stringify(copy, null, 2), {
    mode: 0o600,
  });
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function checkUpdate() {
  const response = await fetch(UPDATE_URL, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`更新服务暂不可用（${response.status}）`);
  const manifest = await response.json();
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("更新版本信息无效");
  const platform = process.platform === "win32" ? "windows-x86_64" : process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
  const rawEntry = manifest.platforms?.[platform];
  const entry = typeof rawEntry === "string" ? { url: rawEntry } : rawEntry;
  const currentVersion = app.getVersion();
  if (!entry?.url) return { currentVersion, latestVersion: manifest.version, available: false, notes: manifest.notes || "", installable: false };
  const url = new URL(entry.url, UPDATE_URL);
  if (url.origin !== "https://jokerdeck.de5.net" || !url.pathname.startsWith("/client/download/")) throw new Error("更新地址不受信任");
  return {
    currentVersion,
    latestVersion: manifest.version,
    available: compareVersions(manifest.version, currentVersion) > 0,
    notes: manifest.notes || "",
    url: url.href,
    sha256: entry.sha256 || "",
    size: entry.size || 0,
    installable: /^[a-f0-9]{64}$/i.test(entry.sha256 || ""),
  };
}

async function downloadUpdate() {
  const update = await checkUpdate();
  if (!update.available || !update.installable) throw new Error("当前版本没有可验证的安装包");
  const filename = path.basename(new URL(update.url).pathname);
  const updateDirectory = path.join(app.getPath("userData"), "updates");
  await fs.mkdir(updateDirectory, { recursive: true });
  const destination = path.join(updateDirectory, filename);
  const partial = `${destination}.part`;
  const response = await fetch(update.url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`安装包下载失败（${response.status}）`);
  let received = 0;
  const progress = new (require("node:stream").Transform)({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      mainWindow?.webContents.send("download-progress", { received, total: update.size || Number(response.headers.get("content-length")) || 0 });
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial));
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(partial)) digest.update(chunk);
    if (digest.digest("hex").toLowerCase() !== update.sha256.toLowerCase()) throw new Error("安装包校验失败，已取消安装");
    await fs.rename(partial, destination);
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }
  const openError = await shell.openPath(destination);
  if (openError) throw new Error(openError);
  return destination;
}

async function api(pathname, options = {}, token) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_ORIGIN}${pathname}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(options.timeout || 15000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok || (body.code && body.code !== 0))
    throw new Error(body.message || `请求失败（${response.status}）`);
  return body.data ?? body;
}

async function getCatalog(token) {
  const [groups, plaza, settings] = await Promise.all([
    api("/groups/available", {}, token),
    api("/model-plaza", {}, token),
    api("/settings/public"),
  ]);
  const allowedIds = new Set(
    (Array.isArray(groups) ? groups : groups.groups || []).map((group) =>
      typeof group === "number" ? group : group.id,
    ),
  );
  const groupRows = (plaza.groups || [])
    .filter((group) => !allowedIds.size || allowedIds.has(group.id))
    .map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description || "",
      platform: group.platform || "openai",
      rate: group.user_rate_multiplier ?? group.rate_multiplier ?? 1,
      exclusive: Boolean(group.is_exclusive),
      models: (group.models || []).map((model) => model.name).filter(Boolean),
    }));
  const endpoints = [
    ...new Map(
      (settings.custom_endpoints || [])
        .filter(
          (entry) =>
            entry && entry.endpoint && /^https:\/\//.test(entry.endpoint),
        )
        .map((entry) => {
          const origin = new URL(entry.endpoint).origin;
          return [
            origin,
            {
              name:
                entry.name
                  .replace(/GPT|Opus/g, "")
                  .replace(/[（）()]/g, "")
                  .trim() || new URL(origin).host,
              endpoint: origin,
              description: entry.description || "",
            },
          ];
        }),
    ).values(),
  ];
  return { groups: groupRows, endpoints };
}

async function validSession() {
  const session = await readSession();
  if (
    session.token &&
    (!session.expiresAt || Date.now() < session.expiresAt - 60000)
  )
    return session;
  if (!session.refreshToken) throw new Error("登录已过期，请重新登录");
  const refreshed = await api("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  session.token = refreshed.access_token;
  session.refreshToken = refreshed.refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + (refreshed.expires_in || 3600) * 1000;
  await writeSession(session);
  return session;
}

function run(command, args = []) {
  return new Promise((resolve) =>
    execFile(command, args, { timeout: 5000 }, (error, stdout) =>
      resolve({ ok: !error, output: stdout || "" }),
    ),
  );
}

function runDetailed(command, args, timeout = 15000) {
  return new Promise((resolve) =>
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, code: error?.code || 0, output: (stdout || stderr || "").trim() }),
    ),
  );
}

async function detectCodex() {
  const candidates =
    process.platform === "win32"
      ? [
          "codex.exe",
          path.join(
            process.env.LOCALAPPDATA || "",
            "Programs",
            "Codex",
            "Codex.exe",
          ),
        ]
      : [
          "codex",
          "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        ];
  for (const candidate of candidates) {
    const result =
      process.platform === "win32"
        ? await run("cmd.exe", ["/d", "/s", "/c", `"${candidate}" --version`])
        : await run(candidate, ["--version"]);
    if (result.ok)
      return {
        installed: true,
        command: candidate,
        version: result.output.trim().split("\n")[0],
      };
  }
  return { installed: false, command: null, version: "" };
}

async function detectClaude() {
  const candidates =
    process.platform === "win32"
      ? [
          "claude.cmd",
          path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
        ]
      : [
          "claude",
          path.join(os.homedir(), ".local", "bin", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
        ];
  for (const candidate of candidates) {
    const result =
      process.platform === "win32"
        ? await run("cmd.exe", ["/d", "/s", "/c", `"${candidate}" --version`])
        : await run(candidate, ["--version"]);
    if (result.ok)
      return {
        installed: true,
        command: candidate,
        version: result.output.trim().split("\n")[0],
      };
  }
  return { installed: false, command: null, version: "" };
}

async function detectCapabilities() {
  const codex = await detectCodex();
  const claude = await detectClaude();
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let configExists = false;
  let config = "";
  try {
    config = await fs.readFile(path.join(home, "config.toml"), "utf8");
    configExists = true;
  } catch {}
  const pluginRoot = path.join(home, "plugins", "cache", "openai-bundled");
  const pluginNames = ["computer-use", "unified-computer-use"];
  let installedCount = 0;
  for (const name of pluginNames) {
    try {
      await fs.access(path.join(pluginRoot, name));
      installedCount++;
    } catch {}
  }
  const enabledCount = pluginNames.filter((name) => {
    const section = config.match(
      new RegExp(`\\[plugins\\."${name}@openai-bundled"\\]([^\\[]*)`),
    );
    return section && /^enabled\s*=\s*true/m.test(section[1]);
  }).length;
  return {
    platform: process.platform,
    codex,
    claude,
    computerUse: { installed: installedCount > 0, enabled: enabledCount > 0 },
    localizationHelper: await fileExists(localizationHelper()),
    computerUseMcp: await fileExists(computerUseHelper()),
    configExists,
    language: "zh-CN",
  };
}

async function configureComputerUse(tool, enabled) {
  const executable = computerUseHelper();
  if (enabled && !(await fileExists(executable)))
    throw new Error("桌面控制组件缺失，请重新安装客户端");
  if (tool === "claude") {
    const configPath = path.join(os.homedir(), ".claude.json");
    let config = {};
    try {
      config = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Claude Code 配置无法读取，请检查 ~/.claude.json");
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("Claude Code 配置格式无效");
    if (!enabled && !config.mcpServers?.[MCP_NAME]) return;
    if (config.mcpServers && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))
      throw new Error("Claude Code MCP 配置格式无效");
    config.mcpServers ||= {};
    if (enabled)
      config.mcpServers[MCP_NAME] = { type: "stdio", command: executable, args: ["mcp"] };
    else delete config.mcpServers[MCP_NAME];
    if (await fileExists(configPath)) await fs.copyFile(configPath, `${configPath}.jokerdeck.bak`);
    const temporaryPath = `${configPath}.jokerdeck.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, configPath);
    return;
  }
  const codex = await detectCodex();
  if (!codex.installed) throw new Error("未检测到 Codex，无法配置桌面控制 MCP");
  const current = await runDetailed(codex.command, ["mcp", "get", MCP_NAME, "--json"]);
  if (!enabled && !current.ok) return;
  const args = enabled
    ? ["mcp", "add", MCP_NAME, "--", executable, "mcp"]
    : ["mcp", "remove", MCP_NAME];
  const result = await runDetailed(codex.command, args);
  if (!result.ok) throw new Error(result.output || "Codex MCP 配置失败");
}

async function codexIsRunning() {
  if (process.platform === "darwin") {
    const [chatgpt, codex] = await Promise.all([
      run("pgrep", ["-x", "ChatGPT"]),
      run("pgrep", ["-x", "Codex"]),
    ]);
    return chatgpt.ok || codex.ok;
  }
  if (process.platform === "win32") {
    const [codex, chatgpt] = await Promise.all([
      run("tasklist.exe", ["/NH", "/FI", "IMAGENAME eq Codex.exe"]),
      run("tasklist.exe", ["/NH", "/FI", "IMAGENAME eq ChatGPT.exe"]),
    ]);
    return /^\s*(Codex|ChatGPT)\.exe\s/im.test(`${codex.output}\n${chatgpt.output}`);
  }
  return false;
}

async function launchLocalizedCodex() {
  const executable = localizationHelper();
  if (!(await fileExists(executable))) throw new Error("中文启动组件缺失，请重新安装客户端");
  if (await codexIsRunning()) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "中文启动 Codex",
      message: "Codex 正在运行。关闭当前窗口并以中文重新启动？",
      buttons: ["取消", "关闭并重启"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return { cancelled: true };
  }
  const result = await runDetailed(executable, ["--launch-zh"], 120000);
  if (!result.ok && result.code !== 2)
    throw new Error(result.output || "中文启动失败，请检查 Codex 安装状态");
  return { started: true, localized: result.ok, warning: result.ok ? "" : "Codex 已启动，但中文界面未完全验证" };
}

async function updateCodexConfig({ endpoint, apiKey }) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(home, "config.toml");
  let config = "";
  try {
    config = await fs.readFile(configPath, "utf8");
  } catch {}
  const providerHeader = "[model_providers.custom]";
  const providerValues = `name = "JokerApi"\nbase_url = ${JSON.stringify(endpoint || "https://jokerdeck.de5.net")}\nwire_api = "responses"\nrequires_openai_auth = false\nexperimental_bearer_token = ${JSON.stringify(apiKey)}`;
  const headerIndex = config.indexOf(providerHeader);
  if (headerIndex >= 0) {
    const afterHeader = config.slice(headerIndex + providerHeader.length);
    const nextHeader = afterHeader.search(/\n\[[^\n]+\]/);
    const blockEnd =
      nextHeader >= 0
        ? headerIndex + providerHeader.length + nextHeader
        : config.length;
    config = `${config.slice(0, headerIndex)}${providerHeader}\n${providerValues}${config.slice(blockEnd)}`;
  } else {
    config = `${config.trim()}\n\n${providerHeader}\n${providerValues}\n`;
  }
  if (/^model_provider\s*=/m.test(config))
    config = config.replace(
      /^model_provider\s*=.*$/m,
      'model_provider = "custom"',
    );
  else config = `model_provider = "custom"\n${config}`;
  await fs.mkdir(home, { recursive: true });
  try {
    await fs.copyFile(configPath, `${configPath}.jokerdeck.bak`);
  } catch {}
  const temporaryPath = `${configPath}.jokerdeck.tmp`;
  await fs.writeFile(temporaryPath, config, { mode: 0o600 });
  await fs.rename(temporaryPath, configPath);
  return configPath;
}

async function readConfiguredKey() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const config = await fs.readFile(path.join(home, "config.toml"), "utf8");
    const block = config.match(/\[model_providers\.custom\]([^\[]*)/);
    const key = block?.[1].match(
      /^experimental_bearer_token\s*=\s*"((?:\\.|[^"\\])*)"/m,
    );
    return key ? JSON.parse(`"${key[1]}"`) : "";
  } catch {
    return "";
  }
}

async function updateClaudeConfig({ endpoint, apiKey }) {
  const directory = path.join(os.homedir(), ".claude");
  const configPath = path.join(directory, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {}
  settings.env = {
    ...(settings.env || {}),
    ANTHROPIC_BASE_URL: endpoint || "https://jokerdeck.de5.net",
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
  delete settings.env.ANTHROPIC_API_KEY;
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.copyFile(configPath, `${configPath}.jokerdeck.bak`);
  } catch {}
  const temporaryPath = `${configPath}.jokerdeck.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, configPath);
  return configPath;
}

async function readConfiguredClaudeKey() {
  try {
    const settings = JSON.parse(
      await fs.readFile(
        path.join(os.homedir(), ".claude", "settings.json"),
        "utf8",
      ),
    );
    return settings.env?.ANTHROPIC_AUTH_TOKEN || "";
  } catch {
    return "";
  }
}

function launchCodex() {
  if (process.platform === "darwin")
    return spawn("open", ["-a", "ChatGPT"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  if (process.platform === "win32")
    return spawn("cmd.exe", ["/c", "start", "", "codex.exe"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  return spawn("codex", [], { detached: true, stdio: "ignore" }).unref();
}

async function launchClaude(command) {
  if (process.platform === "darwin") {
    const scriptPath = path.join(
      app.getPath("userData"),
      "launch-claude.command",
    );
    const escaped = command.replaceAll("'", "'\\''");
    await fs.writeFile(scriptPath, `#!/bin/zsh\nexec '${escaped}'\n`, {
      mode: 0o700,
    });
    await shell.openPath(scriptPath);
    return;
  }
  if (process.platform === "win32") {
    const scriptPath = path.join(app.getPath("userData"), "launch-claude.cmd");
    await fs.writeFile(scriptPath, `@echo off\r\ncall "${command}"\r\n`);
    const error = await shell.openPath(scriptPath);
    if (error) throw new Error(error);
    return;
  }
  spawn(command, [], { detached: true, stdio: "ignore" }).unref();
}

ipcMain.handle("session", async () => {
  const session = await readSession();
  return { ...session, token: Boolean(session.token), refreshToken: undefined };
});
ipcMain.handle("login", async (_event, credentials) => {
  const previous = await readSession();
  const result = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  if (result.temp_token && !result.access_token) {
    await writeSession({ ...previous, pendingRememberLogin: credentials.rememberLogin !== false });
    return { twoFactor: true, tempToken: result.temp_token };
  }
  if (!result.access_token) throw new Error("登录响应缺少访问令牌");
  const session = {
    token: result.access_token,
    refreshToken: result.refresh_token || "",
    expiresAt: Date.now() + (result.expires_in || 3600) * 1000,
    user: result.user || null,
    selectedGroups: previous.selectedGroups || {},
    selectedEndpoint: previous.selectedEndpoint || null,
    keyGroupIds: {},
    setupDone: previous.setupDone || false,
    rememberLogin: credentials.rememberLogin !== false,
    integrations: previous.integrations || { localization: true, computerUse: {} },
  };
  await writeSession(session);
  return { user: session.user, catalog: await getCatalog(session.token) };
});
ipcMain.handle("verify-two-factor", async (_event, { tempToken, code }) => {
  const previous = await readSession();
  const result = await api("/auth/login/2fa", {
    method: "POST",
    body: JSON.stringify({ temp_token: tempToken, totp_code: code }),
  });
  if (!result.access_token) throw new Error("验证码无效");
  const session = {
    token: result.access_token,
    refreshToken: result.refresh_token || "",
    expiresAt: Date.now() + (result.expires_in || 3600) * 1000,
    user: result.user || null,
    selectedGroups: previous.selectedGroups || {},
    selectedEndpoint: previous.selectedEndpoint || null,
    keyGroupIds: {},
    setupDone: previous.setupDone || false,
    rememberLogin: previous.pendingRememberLogin !== false,
    integrations: previous.integrations || { localization: true, computerUse: {} },
  };
  await writeSession(session);
  return { user: session.user };
});
ipcMain.handle("set-login-preference", async (_event, rememberLogin) => {
  const session = await readSession();
  await writeSession({ ...session, pendingRememberLogin: Boolean(rememberLogin) });
  return true;
});
ipcMain.handle("logout", async () => {
  const session = await readSession();
  await writeSession({
    selectedGroups: session.selectedGroups || {},
    selectedEndpoint: session.selectedEndpoint || null,
    keyGroupIds: {},
    token: "",
    refreshToken: "",
    user: null,
    rememberLogin: false,
    setupDone: session.setupDone || false,
    integrations: session.integrations || { localization: true, computerUse: {} },
  });
  return true;
});
ipcMain.handle("set-integrations", async (_event, { tool, localization, computerUse }) => {
  const session = await readSession();
  const integrations = {
    localization: typeof localization === "boolean"
      ? localization : session.integrations?.localization !== false,
    computerUse: { ...(session.integrations?.computerUse || {}) },
  };
  if (typeof computerUse === "boolean") {
    const target = tool === "claude" ? "claude" : "codex";
    await configureComputerUse(target, computerUse);
    integrations.computerUse[target] = computerUse;
  }
  await writeSession({ ...session, integrations });
  return integrations;
});
ipcMain.handle("computer-use-permissions", async () => {
  if (process.platform !== "darwin") return false;
  const executable = computerUseHelper();
  if (!(await fileExists(executable))) throw new Error("桌面控制组件缺失");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["doctor"], { detached: true, stdio: "ignore" });
    child.once("spawn", () => { child.unref(); resolve(true); });
    child.once("error", reject);
  });
});
ipcMain.handle("catalog", async () => {
  const session = await validSession();
  return getCatalog(session.token);
});
ipcMain.handle("save-preferences", async (_event, preferences) => {
  const session = await readSession();
  const endpoint =
    preferences.selectedEndpoint?.endpoint || "https://jokerdeck.de5.net";
  const tool = preferences.tool === "claude" ? "claude" : "codex";
  if (session.integrations?.computerUse?.[tool]) await configureComputerUse(tool, true);
  if (tool === "claude")
    await updateClaudeConfig({ endpoint, apiKey: preferences.apiKey });
  else await updateCodexConfig({ endpoint, apiKey: preferences.apiKey });
  await writeSession({
    ...session,
    selectedGroups: {
      ...(session.selectedGroups || {}),
      [preferences.category]: preferences.selectedGroup,
    },
    selectedEndpoint: preferences.selectedEndpoint,
    keyGroupIds: {
      ...(session.keyGroupIds || {}),
      [tool]: preferences.selectedGroup.id,
    },
    setupDone: true,
  });
  return true;
});
ipcMain.handle("create-key", async (_event, { groupId, name }) => {
  const session = await validSession();
  return api(
    "/keys",
    {
      method: "POST",
      body: JSON.stringify({
        name: name || `jokerdeck-client-${Date.now()}`,
        group_id: groupId,
      }),
    },
    session.token,
  );
});
ipcMain.handle("configured-key", async (_event, { groupId, tool }) => {
  const session = await readSession();
  if (session.keyGroupIds?.[tool] !== groupId) return "";
  return tool === "claude" ? readConfiguredClaudeKey() : readConfiguredKey();
});
ipcMain.handle("health-check", async (_event, endpoints) =>
  Promise.all(
    endpoints.map(async (entry) => {
      const started = Date.now();
      try {
        const response = await fetch(entry.endpoint, {
          method: "GET",
          signal: AbortSignal.timeout(6500),
        });
        return {
          ...entry,
          latency: Date.now() - started,
          ok: response.status < 500,
          status: response.status,
        };
      } catch {
        return { ...entry, latency: null, ok: false, status: 0 };
      }
    }),
  ),
);
ipcMain.handle("capabilities", detectCapabilities);
ipcMain.handle("launch-codex", async (_event, { localized } = {}) => {
  const codex = await detectCodex();
  if (!codex.installed) throw new Error("未检测到 Codex，请先安装官方客户端");
  if (localized !== false) return launchLocalizedCodex();
  launchCodex();
  return { started: true, localized: false };
});
ipcMain.handle("launch-claude", async () => {
  const claude = await detectClaude();
  if (!claude.installed)
    throw new Error("未检测到 Claude Code，请先安装官方客户端");
  await launchClaude(claude.command);
  return true;
});
ipcMain.handle("open-url", (_event, url) => shell.openExternal(url));
ipcMain.handle("check-update", checkUpdate);
ipcMain.handle("download-update", downloadUpdate);
ipcMain.handle("app-version", () => app.getVersion());

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    title: "Jokerdeck Switch",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    backgroundColor: "#f5f7f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}
app.whenReady().then(() => {
  if (process.platform === "darwin")
    app.dock.setIcon(path.join(__dirname, "..", "assets", "icon.png"));
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
