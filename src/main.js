const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, safeStorage, shell, Tray } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createWriteStream, createReadStream } = require("node:fs");
const os = require("node:os");
const { execFile, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { NodeRuntime } = require("./node-runtime");
const { normalizeNodePolicy } = require("./node-subscription");
const { normalizeLocalProxy, proxyServerArgument, proxiedDesktopEnvironment, probeOfficialProxy } = require("./startup-proxy");
const { normalizeOpenAiEndpoint, extractApiKey } = require("./openai-endpoint");
const { localizedLaunchResult } = require("./localization-result");
const { backupOriginalCodexConfig, hasOriginalCodexBackup, restoreOriginalCodexConfig } = require("./codex-config-backup");
const { createDiagnostics } = require("./diagnostics");
const {
  parseWindowsAppPath,
  parseWindowsCommandPaths,
  windowsCodexAppCandidates,
  windowsCodexCliCandidates,
} = require("./codex-detection");

const API_ORIGIN = "https://jokerdeck.de5.net/api/v1";
const SESSION_FILE = () => path.join(app.getPath("userData"), "session.json");
const UPDATE_URL = "https://jokerdeck.de5.net/client/download/switch-latest.json";
let mainWindow;
let transientSession = null;
let computerUseInstallPromise = null;
let nodeRuntime = null;
let nodeSupervisor = null;
let nodeSupervisorBusy = false;
let tray = null;
let quitting = false;
let exitCleanupStarted = false;
let proxyPaused = false;
let managedCodexLaunch = false;
let sessionEpoch = 0;
let logsUnlocked = false;
let diagnostics;
const MCP_NAME = "jokerdeck-computer-use";
const DEFAULT_INTEGRATIONS = Object.freeze({
  localization: true,
  computerUse: { codex: true, claude: false },
  officialNetwork: true,
});

function normalizeIntegrations(value = {}) {
  return {
    localization: value.localization !== false,
    computerUse: {
      codex: value.computerUse?.codex !== false,
      claude: value.computerUse?.claude === true,
    },
    // Official routing is the launcher's resident connectivity path.
    officialNetwork: true,
  };
}


// Electron's network stack follows the desktop proxy and certificate settings;
// Node's global fetch does not on Windows.
const networkFetch = (...args) => net.fetch(...args);

function getDiagnostics() {
  if (!diagnostics) diagnostics = createDiagnostics({ directory: path.join(app.getPath("userData"), "logs") });
  return diagnostics;
}
function safeLog(event, status) {
  return getDiagnostics().append(event, status).catch(() => {});
}

function getNodeRuntime() {
  if (!nodeRuntime) nodeRuntime = new NodeRuntime({
    root: app.isPackaged ? process.resourcesPath : path.join(__dirname, ".."),
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    fetchImpl: networkFetch,
  });
  return nodeRuntime;
}

async function autoStartNode() {
  if (nodeSupervisorBusy || quitting || proxyPaused) return;
  nodeSupervisorBusy = true;
  const epoch = sessionEpoch;
  try {
    const session = await readSession();
    if ((!session.token && !session.refreshToken) || sessionEpoch !== epoch) return;
    const active = await validSession();
    if (sessionEpoch !== epoch) return;
    const policy = await getNodePolicy(active.token);
    if (sessionEpoch !== epoch) return;
    const runtime = getNodeRuntime();
    runtime.setPolicy(policy);
    await runtime.connect();
    if (sessionEpoch !== epoch) runtime.disconnect();
  } catch {
    console.warn("官方代理自动启动失败；可在客户端检查代理状态");
    await safeLog("proxy", "failed");
  } finally {
    nodeSupervisorBusy = false;
  }
}

async function getNodePolicy(token) {
  const response = await networkFetch(`${API_ORIGIN}/client/node-policy`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) throw new Error("节点策略接口尚未部署，请先更新中转站服务端");
  if (!response.ok) throw new Error(`节点策略读取失败（${response.status}）`);
  const body = await response.json();
  if (body.code && body.code !== 0) throw new Error(body.message || "节点策略读取失败");
  return normalizeNodePolicy(body.data || body);
}

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

function bundledComputerUseHelper() {
  return process.platform === "win32"
    ? path.join(helperRoot(), "open-computer-use.exe")
    : path.join(helperRoot(), "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse");
}

async function computerUseHelper() {
  const sourceExecutable = bundledComputerUseHelper();
  if (process.platform !== "darwin") return sourceExecutable;
  if (!computerUseInstallPromise) {
    computerUseInstallPromise = (async () => {
      if (!(await fileExists(sourceExecutable)))
        throw new Error("桌面控制组件缺失，请重新安装客户端");
      const targetApp = path.join(os.homedir(), "Applications", "Jokerdeck Computer Use.app");
      const targetExecutable = path.join(targetApp, "Contents", "MacOS", "OpenComputerUse");
      const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
      if (await fileExists(targetExecutable)) {
        const [source, installed] = await Promise.all([
          fs.readFile(sourceExecutable), fs.readFile(targetExecutable),
        ]);
        if (digest(source) === digest(installed) &&
          await fileExists(path.join(path.dirname(path.dirname(targetExecutable)), "Resources", "Jokerdeck.icns")))
          return targetExecutable;
      }
      const stagedApp = path.join(os.homedir(), "Applications", "Jokerdeck Computer Use.next.app");
      const backupApp = path.join(os.homedir(), "Applications", `Jokerdeck Computer Use.${Date.now()}.backup.app`);
      await fs.mkdir(path.dirname(targetApp), { recursive: true });
      await fs.rm(stagedApp, { recursive: true, force: true });
      const copied = await runDetailed("ditto", [path.dirname(path.dirname(path.dirname(sourceExecutable))), stagedApp], 120000);
      if (!copied.ok) throw new Error(copied.output || "桌面控制组件安装失败");
      const iconSource = path.join(__dirname, "..", "assets", "icon.png");
      const iconset = path.join(app.getPath("userData"), "jokerdeck.iconset");
      const physicalIcon = path.join(app.getPath("userData"), "jokerdeck-icon-source.png");
      const iconResources = path.join(stagedApp, "Contents", "Resources");
      await fs.rm(iconset, { recursive: true, force: true });
      await fs.mkdir(iconset, { recursive: true });
      try {
        // Native macOS tools cannot read files inside app.asar; materialize the icon first.
        await fs.writeFile(physicalIcon, await fs.readFile(iconSource));
        for (const size of [16, 32, 128, 256, 512]) {
          for (const scale of [1, 2]) {
            const filename = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
            const result = await runDetailed("sips", ["-z", String(size * scale), String(size * scale), physicalIcon, "--out", path.join(iconset, filename)], 15000);
            if (!result.ok) throw new Error(result.output || "桌面控制图标生成失败");
          }
        }
        const result = await runDetailed("iconutil", ["-c", "icns", iconset, "-o", path.join(iconResources, "Jokerdeck.icns")], 30000);
        if (!result.ok) throw new Error(result.output || "桌面控制图标打包失败");
      } finally {
        await fs.rm(iconset, { recursive: true, force: true });
        await fs.rm(physicalIcon, { force: true });
      }
      await fs.copyFile(path.join(iconResources, "Jokerdeck.icns"), path.join(iconResources, "OpenComputerUse.icns"));
      const plist = path.join(stagedApp, "Contents", "Info.plist");
      await runDetailed("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIconFile Jokerdeck.icns", plist], 10000);
      await runDetailed("codesign", ["--force", "--deep", "--sign", "-", stagedApp], 120000);
      const verified = await runDetailed("codesign", ["--verify", "--deep", "--strict", stagedApp]);
      if (!verified.ok) throw new Error("桌面控制组件签名校验失败");
      const previousExists = await fileExists(targetApp);
      if (previousExists) await fs.rename(targetApp, backupApp);
      try {
        await fs.rename(stagedApp, targetApp);
      } catch (error) {
        if (previousExists) await fs.rename(backupApp, targetApp);
        throw error;
      }
      if (previousExists) await fs.rm(backupApp, { recursive: true, force: true });
      return targetExecutable;
    })().catch((error) => {
      computerUseInstallPromise = null;
      throw error;
    });
  }
  return computerUseInstallPromise;
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
  if (transientSession) return { ...transientSession, integrations: normalizeIntegrations(transientSession.integrations) };
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
    return { rememberLogin: true, ...raw, integrations: normalizeIntegrations(raw.integrations) };
  } catch {
    return {
      token: "",
      user: null,
      selectedGroup: null,
      selectedEndpoint: null,
      setupDone: false,
      rememberLogin: true,
      integrations: normalizeIntegrations(),
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
  const response = await networkFetch(UPDATE_URL, { cache: "no-store", signal: AbortSignal.timeout(12000) });
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
  const response = await networkFetch(update.url, { signal: AbortSignal.timeout(300000) });
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
  const response = await networkFetch(`${API_ORIGIN}${pathname}`, {
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
      typeof group === "object"
        ? group.id ?? group.group_id ?? group.groupId
        : group,
    ).filter((id) => id !== undefined && id !== null).map(String),
  );
  const groupRows = (plaza.groups || [])
    .filter((group) => !allowedIds.size || allowedIds.has(String(group.id)))
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
          const endpoint = new URL(entry.endpoint).href.replace(/\/$/, "");
          return [
            endpoint,
            {
              name:
                String(entry.name || "")
                  .replace(/GPT|Opus/g, "")
                  .replace(/[（）()]/g, "")
                  .trim() || new URL(endpoint).host,
              endpoint,
              description: entry.description || "",
            },
          ];
        }),
    ).values(),
  ];
  return { groups: groupRows, endpoints };
}

async function validSession() {
  const epoch = sessionEpoch;
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
  if (epoch !== sessionEpoch) throw new Error("登录状态已变化，请重新登录");
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

function runDetailed(command, args, timeout = 15000, options = {}) {
  return new Promise((resolve) =>
    execFile(command, args, { timeout, windowsHide: true, ...options }, (error, stdout, stderr) =>
      resolve({ ok: !error, code: error?.code || 0, output: (stdout || stderr || "").trim() }),
    ),
  );
}

function windowsQuote(value) {
  const text = String(value);
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\\"')}"`;
}

function runCodexCli(command, args, timeout = 15000) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    const invocation = [command, ...args].map(windowsQuote).join(" ");
    return runDetailed("cmd.exe", ["/d", "/s", "/c", invocation], timeout);
  }
  return runDetailed(command, args, timeout);
}

async function detectCodex() {
  let candidates;
  if (process.platform === "win32") {
    const discovered = [];
    for (const command of ["codex.exe", "codex.cmd", "codex"]) {
      const where = await runDetailed("where.exe", [command]);
      discovered.push(...parseWindowsCommandPaths(where.output));
    }
    for (const key of [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\codex.exe",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\codex.exe",
      "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\codex.exe",
    ]) {
      const registry = await runDetailed("reg.exe", ["query", key, "/ve"]);
      discovered.push(...parseWindowsAppPath(registry.output));
    }
    candidates = windowsCodexCliCandidates(discovered, process.env);
  } else {
    candidates = [
      "codex",
      ...["/Applications", path.join(os.homedir(), "Applications")].flatMap((directory) =>
        ["Codex.app", "ChatGPT.app"].map((bundle) =>
          path.join(directory, bundle, "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"))),
    ];
  }
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
  if (process.platform === "win32") {
    for (const candidate of windowsCodexAppCandidates(process.env)) {
      if (await fileExists(candidate))
        return { installed: true, command: candidate, version: "桌面端已安装", desktop: true };
    }
  } else if (process.platform === "darwin") {
    for (const directory of ["/Applications", path.join(os.homedir(), "Applications")]) {
      for (const bundle of ["Codex.app", "ChatGPT.app"]) {
        const executable = path.join(directory, bundle, "Contents", "MacOS", bundle.replace(".app", ""));
        if (await fileExists(executable))
          return { installed: true, command: executable, version: "桌面端已安装", desktop: true };
      }
    }
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
  const desktopInstalled = process.platform === "win32"
    ? Boolean(await windowsCodexExecutable().catch(() => ""))
    : process.platform === "darwin"
      ? Boolean(await macCodexExecutable().catch(() => "")) : codex.installed;
  return {
    platform: process.platform,
    codex: { ...codex, desktopInstalled },
    claude,
    localizationHelper: await fileExists(localizationHelper()),
    computerUseMcp: await fileExists(bundledComputerUseHelper()),
    configExists: await fileExists(path.join(home, "config.toml")),
    language: "zh-CN",
  };
}

async function configureComputerUse(tool, enabled) {
  const executable = enabled ? await computerUseHelper() : bundledComputerUseHelper();
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
  if (!codex.installed) {
    if (!enabled) return;
    throw new Error("桌面控制 MCP 需要 Codex CLI；中转和桌面启动不受影响");
  }
  if (codex.desktop) {
    if (!enabled) return;
    throw new Error("桌面控制 MCP 需要 Codex CLI；中转和桌面启动不受影响");
  }
  await fs.mkdir(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), { recursive: true });
  const current = await runCodexCli(codex.command, ["mcp", "get", MCP_NAME, "--json"]);
  if (!enabled && !current.ok) return;
  const args = enabled
    ? ["mcp", "add", MCP_NAME, "--", executable, "mcp"]
    : ["mcp", "remove", MCP_NAME];
  const result = await runCodexCli(codex.command, args);
  if (!result.ok) throw new Error(result.output || "Codex MCP 配置失败");
  if (enabled) {
    const verified = await runCodexCli(codex.command, ["mcp", "get", MCP_NAME, "--json"]);
    if (!verified.ok) throw new Error(verified.output || "Codex MCP 注册后校验失败");
  }
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

async function quitRunningCodex() {
  if (process.platform === "darwin")
    await Promise.all(["ChatGPT", "Codex"].map(async (name) => {
      if ((await run("pgrep", ["-x", name])).ok)
        await runDetailed("osascript", ["-e", `tell application \"${name}\" to quit`], 15000);
    }));
  if (process.platform === "win32") {
    await Promise.all([
      runDetailed("taskkill.exe", ["/IM", "Codex.exe"], 15000),
      runDetailed("taskkill.exe", ["/IM", "ChatGPT.exe"], 15000),
    ]);
  }
  for (let attempt = 0; attempt < 15 && await codexIsRunning(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  if (await codexIsRunning()) throw new Error("Codex 尚未完全退出，请关闭后重试");
}

async function launchLocalizedCodex(proxy = "") {
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
    await quitRunningCodex();
  }
  const address = proxy ? normalizeLocalProxy(proxy) : "";
  const env = address ? proxiedDesktopEnvironment(address) : process.env;
  const args = ["--launch-zh", ...(address ? [proxyServerArgument(proxy)] : [])];
  const result = await runDetailed(executable, args, 120000, { env });
  return localizedLaunchResult(result);
}

async function updateCodexConfig({ endpoint, apiKey }) {
  await safeLog("write", "active");
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
  await backupOriginalCodexConfig(configPath);
  const temporaryPath = `${configPath}.jokerdeck.tmp`;
  await fs.writeFile(temporaryPath, config, { mode: 0o600 });
  await fs.rename(temporaryPath, configPath);
  await safeLog("write", "done");
  return configPath;
}

async function restoreOfficialCodexConfig() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return restoreOriginalCodexConfig(path.join(home, "config.toml"));
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

async function readConfiguredEndpoint() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const config = await fs.readFile(path.join(home, "config.toml"), "utf8");
    const block = config.match(/\[model_providers\.custom\]([^\[]*)/);
    const value = block?.[1].match(
      /^base_url\s*=\s*"((?:\\.|[^"\\])*)"/m,
    );
    return value ? JSON.parse(`"${value[1]}"`) : "";
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

async function readConfiguredClaudeEndpoint() {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
    return settings.env?.ANTHROPIC_BASE_URL || "";
  } catch {
    return "";
  }
}

async function macCodexExecutable() {
  for (const directory of ["/Applications", path.join(os.homedir(), "Applications")]) {
    for (const name of ["Codex", "ChatGPT"]) {
      const executable = path.join(directory, `${name}.app`, "Contents", "MacOS", name);
      if (await fileExists(executable)) return executable;
    }
  }
  throw new Error("找不到 Codex/ChatGPT 桌面应用");
}

async function windowsCodexExecutable() {
  for (const candidate of windowsCodexAppCandidates(process.env)) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error("找不到 Codex/ChatGPT 桌面应用");
}

async function launchCodex(proxy = "") {
  const args = proxy ? [proxyServerArgument(proxy)] : [];
  if (proxy) {
    const address = normalizeLocalProxy(proxy);
    const env = proxiedDesktopEnvironment(address);
    let executable;
    if (process.platform === "darwin") {
      executable = await macCodexExecutable();
    } else if (process.platform === "win32") {
      executable = await windowsCodexExecutable();
    } else executable = "codex";
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { env, detached: true, stdio: "ignore", windowsHide: true });
      child.once("spawn", () => { child.unref(); resolve(); });
      child.once("error", reject);
    });
    return;
  }
  if (process.platform === "darwin") {
    const result = await runDetailed("open", ["-a", path.dirname(path.dirname(path.dirname(await macCodexExecutable()))), ...(args.length ? ["--args", ...args] : [])], 15000);
    if (!result.ok) throw new Error(result.output || "Codex 启动失败");
    return;
  }
  if (process.platform === "win32") {
    const executable = await windowsCodexExecutable();
    return spawn("cmd.exe", ["/c", "start", "", executable, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  }
  return spawn("codex", args, { detached: true, stdio: "ignore" }).unref();
}

async function launchProxiedCodex(proxy, localized, detectedExecutable = "") {
  if (await codexIsRunning()) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "重启 Codex 并连接节点",
      message: "Codex 正在运行。请保存当前工作，关闭 Codex 后继续以节点重新启动。",
      buttons: ["取消", "继续"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return { cancelled: true };
    await quitRunningCodex();
  }
  if (localized) {
    const result = await launchLocalizedCodex(proxy);
    return { ...result, warning: `${result.warning || ""} 请在 Codex 官方设置中确认 Computer Use 可用。`.trim() };
  }
  await launchCodex(proxy, detectedExecutable);
  return { started: true, localized: false, warning: "请在 Codex 官方设置中确认 Computer Use 可用。" };
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
    integrations: normalizeIntegrations(previous.integrations),
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
    integrations: normalizeIntegrations(previous.integrations),
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
  logsUnlocked = false;
  sessionEpoch += 1;
  const session = await readSession();
  nodeRuntime?.disconnect();
  await writeSession({
    selectedGroups: session.selectedGroups || {},
    selectedEndpoint: session.selectedEndpoint || null,
    keyGroupIds: {},
    token: "",
    refreshToken: "",
    user: null,
    rememberLogin: false,
    setupDone: session.setupDone || false,
    integrations: normalizeIntegrations(session.integrations),
  });
  return true;
});
ipcMain.handle("set-integrations", async (_event, { tool, localization, computerUse, officialNetwork }) => {
  const session = await readSession();
  const integrations = {
    localization: typeof localization === "boolean"
      ? localization : session.integrations?.localization !== false,
    computerUse: { ...normalizeIntegrations(session.integrations).computerUse },
    officialNetwork: true,
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
  const executable = await computerUseHelper();
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
  const tool = preferences.tool === "claude" ? "claude" : "codex";
  const officialCodex = tool === "codex" && preferences.officialNetwork === true;
  const endpoint = tool === "codex"
    ? normalizeOpenAiEndpoint(preferences.selectedEndpoint?.endpoint, preferences.useV1 !== false)
    : (preferences.selectedEndpoint?.endpoint || "https://jokerdeck.de5.net");
  let mcpWarning = "";
  if (session.integrations?.computerUse?.[tool]) {
    try {
      await configureComputerUse(tool, true);
    } catch (error) {
      mcpWarning = `本地桌面控制 MCP 未启用：${error.message || error}`;
    }
  }
  let configPath;
  if (tool === "claude") {
    configPath = await updateClaudeConfig({ endpoint, apiKey: preferences.apiKey });
  } else {
    configPath = await updateCodexConfig({ endpoint, apiKey: preferences.apiKey });
    const [writtenEndpoint, writtenKey] = await Promise.all([
      readConfiguredEndpoint(),
      readConfiguredKey(),
    ]);
    if (writtenEndpoint !== endpoint || !writtenKey || writtenKey !== preferences.apiKey)
      throw new Error("Codex 配置写入校验失败，请重试；当前配置未确认生效");
  }
  await writeSession({
    ...session,
    selectedGroups: preferences.selectedGroup
      ? {
          ...(session.selectedGroups || {}),
          [preferences.category]: preferences.selectedGroup,
        }
      : session.selectedGroups || {},
    selectedEndpoint: preferences.selectedEndpoint,
    useV1: preferences.useV1 !== false,
    keyGroupIds: preferences.selectedGroup
      ? { ...(session.keyGroupIds || {}), [tool]: preferences.selectedGroup.id }
      : session.keyGroupIds || {},
    activeConfig: preferences.selectedGroup
      ? {
          groupId: preferences.selectedGroup.id,
          group: preferences.selectedGroup.name || "",
          category: preferences.category || "openai",
          tool,
          mode: officialCodex ? "official-node-relay" : "relay",
          route: preferences.selectedEndpoint?.endpoint || "",
          endpoint,
          configPath,
          provider: "custom",
          wireApi: tool === "codex" ? "responses" : "",
          requiresOpenAiAuth: false,
        }
      : session.activeConfig || null,
    setupDone: true,
  });
  return {
    endpoint,
    mode: officialCodex ? "official-node-relay" : "relay",
    apiKey: preferences.apiKey || "",
    mcpWarning,
    apiKeyPrefix: preferences.apiKey ? `${preferences.apiKey.slice(0, 6)}…${preferences.apiKey.slice(-4)}` : "",
    configPath,
  };
});
ipcMain.handle("create-key", async (_event, { groupId, name }) => {
  const session = await validSession();
  const result = await api(
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
  return { ...result, key: extractApiKey(result) };
});
ipcMain.handle("configured-key", async (_event, { groupId, tool }) => {
  const session = await readSession();
  if (session.keyGroupIds?.[tool] == null || String(session.keyGroupIds[tool]) !== String(groupId)) return "";
  return tool === "claude" ? readConfiguredClaudeKey() : readConfiguredKey();
});
ipcMain.handle("configured-config", async (_event, { tool } = {}) => {
  const configPath = tool === "claude"
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  if (tool === "claude") {
    return { configPath, endpoint: await readConfiguredClaudeEndpoint(), apiKey: await readConfiguredClaudeKey() };
  }
  return {
    configPath,
    endpoint: await readConfiguredEndpoint(),
    apiKey: await readConfiguredKey(),
    provider: "custom",
    wireApi: "responses",
    requiresOpenAiAuth: false,
  };
});
ipcMain.handle("health-check", async (_event, endpoints) =>
  Promise.all(
    endpoints.map(async (entry) => {
      const started = Date.now();
      try {
        const response = await networkFetch(entry.endpoint, {
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
ipcMain.handle("node-status", () => getNodeRuntime().status());
ipcMain.handle("node-connect", async () => {
  proxyPaused = false;
  const session = await validSession();
  const runtime = getNodeRuntime();
  runtime.setPolicy(await getNodePolicy(session.token));
  const status = await runtime.connect();
  return { ...status, codexRunning: await codexIsRunning() };
});
ipcMain.handle("node-refresh", async () => {
  proxyPaused = false;
  const session = await validSession();
  const runtime = getNodeRuntime();
  runtime.setPolicy(await getNodePolicy(session.token));
  return runtime.connect();
});
ipcMain.handle("node-disconnect", () => getNodeRuntime().disconnect());
ipcMain.handle("codex-restore-status", () =>
  hasOriginalCodexBackup(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml")));
ipcMain.handle("restore-codex-config", async () => {
  const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  if (!(await hasOriginalCodexBackup(configPath)))
    throw new Error("找不到 Jokerdeck 写入前的原配置备份，未修改现有文件");
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "恢复 Codex 原配置",
    message: "恢复 Jokerdeck 修改前的 Codex 配置？",
    detail: "将关闭正在运行的 Codex，停止本机代理，并另存当前 config.toml；官方登录数据和中转账号不受影响。",
    buttons: ["取消", "恢复原配置"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return { cancelled: true };
  await safeLog("restore", "active");
  try {
    if (await codexIsRunning()) await quitRunningCodex();
    proxyPaused = true;
    sessionEpoch += 1;
    nodeRuntime?.disconnect();
    const result = await restoreOfficialCodexConfig();
    if (result.restored) {
      managedCodexLaunch = false;
      const session = await readSession();
      if (session.activeConfig?.tool === "codex")
        await writeSession({ ...session, activeConfig: null });
    }
    await safeLog("restore", "done");
    return result;
  } catch (error) {
    await safeLog("restore", "failed");
    throw error;
  }
});
ipcMain.handle("launch-codex", async (_event, { localized, officialNetwork } = {}) => {
  await safeLog("start", "active");
  const codex = await detectCodex();
  if (!codex.installed) throw new Error("未检测到 Codex，请先安装官方客户端");
  if (process.platform === "win32") await windowsCodexExecutable();
  if (process.platform === "darwin") await macCodexExecutable();
  if (officialNetwork) {
    await safeLog("proxy", "active");
    proxyPaused = false;
    const session = await validSession();
    const runtime = getNodeRuntime();
    runtime.setPolicy(await getNodePolicy(session.token));
    const status = await runtime.connect();
    const result = await launchProxiedCodex(`127.0.0.1:${status.port}`, localized !== false, codex.command);
    await safeLog("proxy", result.cancelled ? "failed" : "done");
    if (result.started) managedCodexLaunch = true;
    if (result.started) await safeLog("start", "done");
    return result;
  }
  if (localized !== false) {
    const result = await launchLocalizedCodex();
    if (result.started) managedCodexLaunch = true;
    if (result.started) await safeLog("start", "done");
    return result;
  }
  await launchCodex("", codex.command);
  managedCodexLaunch = true;
  await safeLog("start", "done");
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
ipcMain.handle("logs-unlock", async (_event, password) => {
  logsUnlocked = await getDiagnostics().verifyPassword(String(password || ""));
  return logsUnlocked;
});
ipcMain.handle("logs-lock", () => { logsUnlocked = false; return true; });
ipcMain.handle("logs-entries", async () => {
  if (!logsUnlocked) throw new Error("请先解锁日志");
  return getDiagnostics().entries();
});
ipcMain.handle("logs-change-password", async (_event, { oldPassword, newPassword } = {}) => {
  if (!logsUnlocked) throw new Error("请先解锁日志");
  const changed = await getDiagnostics().changePassword(String(oldPassword || ""), String(newPassword || ""));
  if (changed) logsUnlocked = false;
  return changed;
});
ipcMain.handle("logs-event", async (_event, { event: name, status } = {}) => {
  await getDiagnostics().append(name, status);
  return true;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 680,
    minWidth: 580,
    minHeight: 540,
    autoHideMenuBar: process.platform === "win32",
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
  if (process.platform === "win32") Menu.setApplicationMenu(null);
  if (process.platform === "darwin")
    app.dock.setIcon(path.join(__dirname, "..", "assets", "icon.png"));
  if (process.platform === "win32") {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png")));
    tray.setToolTip("Jokerdeck Switch · 常驻代理");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 Jokerdeck Switch", click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        else mainWindow.show();
      } },
      { label: "退出（代理将停止）", click: () => app.quit() },
    ]));
    tray.on("double-click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else mainWindow.show();
    });
  }
  createWindow();
  void autoStartNode();
  nodeSupervisor = setInterval(() => {
    if (nodeSupervisorBusy || nodeRuntime?.connectPromise) return;
    const status = nodeRuntime?.status();
    if (!status?.connected || !status.officialReachable) {
      void autoStartNode();
      return;
    }
    void probeOfficialProxy(`127.0.0.1:${status.port}`, 8000).catch(() => {
      if (nodeRuntime?.status().connected && nodeRuntime.status().port === status.port) {
        nodeRuntime.officialReachable = false;
        void autoStartNode();
      }
    });
  }, 30000);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && process.platform !== "win32") app.quit();
});
app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
});
app.on("before-quit", (event) => {
  if (exitCleanupStarted) return;
  event.preventDefault();
  exitCleanupStarted = true;
  quitting = true;
  proxyPaused = true;
  sessionEpoch += 1;
  if (nodeSupervisor) clearInterval(nodeSupervisor);
  void (async () => {
    await safeLog("exit", "active");
    let cleanupFailed = false;
    try {
      if (managedCodexLaunch && await codexIsRunning()) await quitRunningCodex();
    } catch {
      cleanupFailed = true;
      console.warn("退出时关闭 Codex 失败");
    }
    try {
      const result = await restoreOfficialCodexConfig();
      if (result.restored) {
        const session = await readSession();
        if (session.activeConfig?.tool === "codex")
          await writeSession({ ...session, activeConfig: null });
      }
    } catch {
      cleanupFailed = true;
      console.warn("退出时恢复 Codex 原配置失败；原始备份仍保留，可在客户端重试恢复");
    } finally {
      await safeLog("exit", cleanupFailed ? "failed" : "done");
      nodeRuntime?.disconnect();
      app.quit();
    }
  })();
});
