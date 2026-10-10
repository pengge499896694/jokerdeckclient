const state = {
  catalog: null,
  selectedGroup: null,
  selectedEndpoint: null,
  endpoints: [],
  tempToken: null,
  category: "openai",
  selectedGroups: {},
  update: null,
  integrations: { localization: true, computerUse: { codex: true, claude: false }, officialNetwork: true },
  useV1: true,
  configured: {
    endpoint: "",
    route: "",
    apiKey: "",
    mode: "relay",
    group: "",
    provider: "custom",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    configPath: "",
  },
  activeConfig: null,
  successKeyRevealed: false,
  capabilities: null,
  nodeStatus: { connected: false, port: 0, nodes: 0, latencies: [] },
};
const currentTool = () => (state.category === "anthropic" ? "claude" : "codex");
const currentAppName = () =>
  currentTool() === "claude" ? "Claude Code" : "Codex";
const visibleGroups = () =>
  state.catalog.groups.filter((group) =>
    state.category === "other"
      ? !["openai", "anthropic"].includes(group.platform)
      : group.platform === state.category,
  );
const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const el of document.querySelectorAll(".view"))
    el.classList.toggle("hidden", el.id !== id);
};
const errorText = (error) => error?.message || "操作失败，请稍后重试";

const launchProgressSteps = [
  { id: "check", title: "检查客户端", detail: "确认目标客户端已安装且可以启动" },
  { id: "route", title: "选择最快线路", detail: "测试可用线路并选择响应最快的一条" },
  { id: "key", title: "准备分组密钥", detail: "读取已保存的密钥，必要时创建新的专用密钥" },
  { id: "write", title: "写入本地配置", detail: "保存分组、线路和 API 配置，并保留备份" },
  { id: "start", title: "重启并启动客户端", detail: "让新配置生效，然后打开目标客户端" },
];
let launchProgressState = [];
let nodeRefreshTimer = null;

function renderLaunchProgressSteps() {
  $("launch-steps").innerHTML = launchProgressState
    .map(
      (step, index) =>
        `<li class="launch-step ${step.status}"><span class="launch-step-marker">${step.status === "done" ? "✓" : step.status === "failed" ? "!" : step.status === "active" ? "…" : index + 1}</span><div class="launch-step-copy"><div class="launch-step-title">${escapeHtml(step.title)}</div><div class="launch-step-detail">${escapeHtml(step.detail)}</div></div></li>`,
    )
    .join("");
}

function maskSecret(value) {
  if (!value) return "未配置";
  if (value.length <= 10) return `${value.slice(0, 3)}••••${value.slice(-2)}`;
  return `${value.slice(0, 6)}••••••${value.slice(-4)}`;
}

function currentConfigSummary() {
  const configured = state.configured;
  const official = configured.mode === "official-node-relay";
  return {
    group: configured.group || state.selectedGroup?.name || "未配置",
    mode: official ? "官方节点 + 中转配置" : "中转模式",
    route: configured.route || state.selectedEndpoint?.endpoint || "未配置",
    endpoint: configured.endpoint || "未配置",
    key: maskSecret(configured.apiKey),
  };
}

function renderSuccessConfig() {
  const config = currentConfigSummary();
  const key = state.successKeyRevealed ? state.configured.apiKey || "未配置" : config.key;
  $("success-config").innerHTML = [
    ["连接模式", config.mode],
    ["分组", config.group],
    ["线路 URL", config.route],
    ["请求 URL", config.endpoint],
    ["model_provider", state.configured.provider || "custom"],
    ["wire_api", state.configured.wireApi || "responses"],
    ["requires_openai_auth", String(Boolean(state.configured.requiresOpenAiAuth))],
    ["配置文件", state.configured.configPath || "未配置"],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`).join("");
  const keyRow = document.createElement("div");
  keyRow.innerHTML = `<span>API Key</span><code>${escapeHtml(key)}</code><button id="success-reveal-key" class="icon-button" type="button" title="显示或隐藏 API Key" aria-label="显示或隐藏 API Key">${state.successKeyRevealed ? "◉" : "◌"}</button>`;
  $("success-config").prepend(keyRow);
  $("success-reveal-key").addEventListener("click", () => {
    state.successKeyRevealed = !state.successKeyRevealed;
    renderSuccessConfig();
  });
  $("success-config").classList.remove("hidden");
}

function openLaunchProgress(tool) {
  launchProgressState = launchProgressSteps.map((step) => ({ ...step, status: "pending" }));
  $("launch-progress-title").textContent = `正在准备 ${tool === "claude" ? "Claude Code" : "Codex"}`;
  $("launch-progress-detail").textContent = "正在开始…";
  $("launch-progress-error").textContent = "";
  $("launch-progress-close").classList.add("hidden");
  $("launch-changes").classList.add("hidden");
  $("launch-changes-list").innerHTML = "";
  $("launch-progress-bar").style.width = "0%";
  $("launch-progress-percent").textContent = "0%";
  renderLaunchProgressSteps();
  $("launch-progress").classList.remove("hidden");
}

function updateLaunchProgress(id, status, detail) {
  const index = launchProgressState.findIndex((step) => step.id === id);
  if (index < 0) return;
  launchProgressState[index].status = status;
  if (detail) launchProgressState[index].detail = detail;
  const completed = launchProgressState.filter((step) => step.status === "done").length;
  const active = launchProgressState.findIndex((step) => step.status === "active");
  const percent = status === "failed" ? Math.max(8, Math.round((completed / launchProgressState.length) * 100)) : Math.round(((completed + (active >= 0 ? 0.35 : 0)) / launchProgressState.length) * 100);
  $("launch-progress-bar").style.width = `${percent}%`;
  $("launch-progress-percent").textContent = `${percent}%`;
  $("launch-progress-detail").textContent = detail || launchProgressState[index].detail;
  renderLaunchProgressSteps();
}

function addLaunchChange(change) {
  if (!change) return;
  const item = document.createElement("li");
  item.textContent = change;
  $("launch-changes-list").append(item);
  $("launch-changes").classList.remove("hidden");
}

function finishLaunchProgress(success, error = "") {
  if (success) {
    launchProgressState.forEach((step) => {
      if (step.status !== "failed") step.status = "done";
    });
    $("launch-progress-bar").style.width = "100%";
    $("launch-progress-percent").textContent = "100%";
    $("launch-progress-detail").textContent = "配置已完成，正在打开客户端";
    renderLaunchProgressSteps();
    return;
  }
  $("launch-progress-error").textContent = error;
  $("launch-progress-close").classList.remove("hidden");
}

function renderGroups() {
  const groups = visibleGroups();
  $("group-count").textContent = groups.length;
  $("groups").innerHTML = groups
    .map(
      (group) =>
        `<button class="group-card ${state.selectedGroup?.id === group.id ? "selected" : ""}" data-group="${group.id}"><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.models.slice(0, 5).join(" · ") || group.description || group.platform)}</small><div class="group-meta"><span>${group.rate}x</span><span>${group.models.length} 个模型</span>${group.exclusive ? "<span>专属</span>" : ""}</div></button>`,
    )
    .join("");
  document.querySelectorAll("[data-group]").forEach((button) =>
    button.addEventListener("click", () => {
      state.selectedGroup = groups.find(
        (group) => String(group.id) === button.dataset.group,
      );
      state.selectedGroups[state.category] = state.selectedGroup;
      renderGroups();
      updateSummary();
    }),
  );
  const detail = $("model-detail");
  detail.classList.toggle("hidden", !state.selectedGroup);
  if (state.selectedGroup) {
    detail.innerHTML = `<strong>${escapeHtml(state.selectedGroup.name)} 的模型</strong><div>${state.selectedGroup.models.map((model) => `<span>${escapeHtml(model)}</span>`).join("")}</div>`;
  }
}
function renderEndpoints() {
  $("endpoints").innerHTML = state.endpoints
    .map(
      (entry, index) =>
        `<button type="button" class="endpoint-row ${state.selectedEndpoint?.endpoint === entry.endpoint ? "active" : ""}" data-endpoint="${escapeHtml(entry.endpoint)}"><span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.description || entry.endpoint)}</small></span><span class="endpoint-latency">${entry.latency == null ? "待测速" : `${entry.latency} ms`}</span></button>`,
    )
    .join("");
  document.querySelectorAll("[data-endpoint]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedEndpoint = state.endpoints.find((entry) => entry.endpoint === button.dataset.endpoint) || null;
      renderEndpoints();
      updateSummary();
    });
  });
}
function renderConfigured() {
  const configured = state.configured;
  $("config-panel").classList.toggle("hidden", !configured.endpoint);
  $("configured-mode").textContent = configured.mode === "official-node-relay" ? "官方节点 + 中转配置" : "中转模式";
  $("configured-group").textContent = configured.group || state.selectedGroup?.name || "未配置";
  $("configured-route").textContent = configured.route || state.selectedEndpoint?.endpoint || "未配置";
  $("configured-endpoint").textContent = configured.endpoint || "未配置";
  const key = configured.apiKey || "";
  const revealed = $("configured-key").dataset.revealed === "true";
  $("configured-key").textContent = key ? (revealed ? key : maskSecret(key)) : "未配置";
  $("reveal-key").textContent = key && revealed ? "◉" : "◌";
  $("reveal-key").title = key && revealed ? "隐藏 API Key" : "显示 API Key";
  $("configured-provider").textContent = configured.provider || "custom";
  $("configured-wire-api").textContent = configured.wireApi || "responses";
  $("configured-auth").textContent = String(Boolean(configured.requiresOpenAiAuth));
  $("configured-path").textContent = configured.configPath || "未配置";
}
function renderCapabilities(data) {
  $("capabilities").innerHTML = [
    [
      "Codex",
      data.codex.installed ? `已检测 ${data.codex.version || ""}` : "未检测到",
    ],
    [
      "Claude Code",
      data.claude.installed
        ? `已检测 ${data.claude.version || ""}`
        : "未检测到",
    ],
    ["中文启动器", data.localizationHelper ? "已内置" : "组件缺失"],
    ["本地桌面控制 MCP", data.computerUseMcp ? "已内置" : "组件缺失"],
    ["本地配置", data.configExists ? "已发现 config.toml" : "首次配置"],
  ]
    .map(
      ([label, value]) =>
        `<div class="capability-row"><span>${label}</span><span class="${value.includes("未") || value.includes("需要") || value.includes("缺失") ? "warn" : "good"}">${value}</span></div>`,
    )
    .join("");
  $("localization-setting").disabled = !data.localizationHelper;
  $("computer-use-setting").disabled = !data.computerUseMcp;
  $("computer-use-permissions").classList.toggle("hidden", data.platform !== "darwin");
}
function renderNodeStatus() {
  const status = $("node-status");
  const delayList = $("node-delays");
  status.classList.toggle("hidden", currentTool() !== "codex");
  $("node-note").classList.toggle("hidden", currentTool() !== "codex" || !state.integrations.officialNetwork);
  status.textContent = state.nodeStatus.connected
    ? `${state.nodeStatus.officialReachable ? "官方站点已连通" : "本机代理已启动"} · 当前 ${escapeHtml(state.nodeStatus.selectedNode || "自动选择")} ${state.nodeStatus.selectedLatency == null ? "" : `${state.nodeStatus.selectedLatency} ms`} · ${state.nodeStatus.nodes} 个候选`
    : "节点未连接";
  const latencies = Array.isArray(state.nodeStatus.latencies) ? state.nodeStatus.latencies : [];
  delayList.classList.toggle("hidden", currentTool() !== "codex" || !latencies.length);
  delayList.innerHTML = latencies.map((entry) =>
    `<span class="node-delay ${entry.ok ? "good" : "bad"}">${escapeHtml(entry.name)} · ${entry.ok ? `${entry.latency} ms` : "不可用"}</span>`,
  ).join("");
  $("official-network-setting").checked = Boolean(state.integrations.officialNetwork);
}
async function refreshNodeStatus(reprobe = false) {
  if (currentTool() !== "codex" || !state.integrations.officialNetwork) return;
  try {
    state.nodeStatus = reprobe ? await window.jokerdeck.nodeRefresh() : await window.jokerdeck.nodeStatus();
    renderNodeStatus();
  } catch (error) {
    state.nodeStatus = { ...state.nodeStatus, connected: false, officialReachable: false };
    renderNodeStatus();
    $("integration-status").textContent = errorText(error);
  }
}
function startNodeRefresh() {
  if (nodeRefreshTimer) clearInterval(nodeRefreshTimer);
  nodeRefreshTimer = setInterval(() => refreshNodeStatus(true), 15000);
}
function stopNodeRefresh() {
  if (nodeRefreshTimer) clearInterval(nodeRefreshTimer);
  nodeRefreshTimer = null;
}
function updateSummary() {
  const officialNetwork = currentTool() === "codex" && Boolean(state.integrations.officialNetwork);
  $("selection-summary").textContent = state.selectedGroup
    ? `${state.selectedGroup.name} · ${state.selectedEndpoint?.name || "线路自动选择"}`
    : officialNetwork ? "官方 Codex · 保留原生登录和插件" : "请选择一个分组";
  $("launch").disabled = !state.selectedGroup && !officialNetwork;
  $("launch").innerHTML = `配置并启动 ${currentAppName()} <span>→</span>`;
}
function setCategory(category) {
  state.category = category;
  state.selectedGroup = state.selectedGroups[category] || null;
  if (state.activeConfig?.category !== category) {
    state.configured = {
      endpoint: "",
      route: "",
      apiKey: "",
      mode: "relay",
      group: "",
      provider: "custom",
      wireApi: "responses",
      requiresOpenAiAuth: false,
      configPath: "",
    };
  }
  $("integration-status").textContent = "";
  $("localization-option").classList.toggle("hidden", currentTool() !== "codex");
  $("official-network-option").classList.toggle("hidden", currentTool() !== "codex");
  $("gpt-v1-option").classList.toggle("hidden", currentTool() !== "codex");
  renderNodeStatus();
  $("localization-setting").checked = state.integrations.localization !== false;
  $("computer-use-setting").checked = Boolean(state.integrations.computerUse?.[currentTool()]);
  document.querySelectorAll("[data-category]").forEach((button) => {
    const active = button.dataset.category === category;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderGroups();
  updateSummary();
  renderConfigured();
}
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}
async function loadSetup() {
  state.catalog = await window.jokerdeck.catalog();
  state.endpoints = state.catalog.endpoints;
  for (const category of ["openai", "anthropic", "other"]) {
    const savedId = state.selectedGroups[category]?.id;
    state.selectedGroups[category] =
      state.catalog.groups.find((group) => String(group.id) === String(savedId)) || null;
  }
  setCategory(state.category);
  renderEndpoints();
  updateSummary();
  state.capabilities = await window.jokerdeck.capabilities();
  state.nodeStatus = await window.jokerdeck.nodeStatus();
  renderCapabilities(state.capabilities);
  renderNodeStatus();
  if (currentTool() === "codex" && state.integrations.officialNetwork) {
    try {
      state.nodeStatus = await window.jokerdeck.nodeConnect();
      startNodeRefresh();
      renderNodeStatus();
    } catch (error) {
      $("integration-status").textContent = errorText(error);
    }
  }
  await chooseFastestEndpoint(false);
  const savedConfig = state.activeConfig?.category === state.category ? state.activeConfig : null;
  if (state.selectedGroups[state.category]) {
    const actualConfig = await window.jokerdeck.configuredConfig({ tool: currentTool() });
    const configuredKey = await window.jokerdeck.configuredKey({
      groupId: state.selectedGroups[state.category].id,
      tool: currentTool(),
    });
    state.configured = {
      ...state.configured,
      ...(savedConfig || {}),
      endpoint: actualConfig.endpoint || savedConfig?.endpoint || (currentTool() === "codex"
        ? `${state.selectedEndpoint?.endpoint || "https://jokerdeck.de5.net"}${state.useV1 && !state.selectedEndpoint?.endpoint?.replace(/\/+$/, "").endsWith("/v1") ? "/v1" : ""}`
        : (state.selectedEndpoint?.endpoint || "")),
      route: savedConfig?.route || state.selectedEndpoint?.endpoint || "",
      apiKey: actualConfig.apiKey || configuredKey || "",
      group: state.selectedGroups[state.category].name,
      configPath: actualConfig.configPath || savedConfig?.configPath || "",
      provider: actualConfig.provider || savedConfig?.provider || "custom",
      wireApi: actualConfig.wireApi || savedConfig?.wireApi || "responses",
      requiresOpenAiAuth: actualConfig.requiresOpenAiAuth ?? savedConfig?.requiresOpenAiAuth ?? false,
    };
  }
  show("setup-view");
  renderConfigured();
}

$("localization-setting").addEventListener("change", async () => {
  const checkbox = $("localization-setting");
  checkbox.disabled = true;
  try {
    state.integrations = await window.jokerdeck.setIntegrations({ localization: checkbox.checked });
    $("integration-status").textContent = "已保存";
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    $("integration-status").textContent = errorText(error);
  } finally {
    checkbox.disabled = !state.capabilities?.localizationHelper;
  }
});
$("official-network-setting").addEventListener("change", async () => {
  const checkbox = $("official-network-setting");
  const enabled = checkbox.checked;
  checkbox.disabled = true;
  $("node-status").textContent = enabled ? "正在连接常驻代理…" : "常驻代理不可关闭…";
  try {
    if (enabled) {
      state.integrations = await window.jokerdeck.setIntegrations({ officialNetwork: true });
      state.nodeStatus = await window.jokerdeck.nodeConnect();
      startNodeRefresh();
      $("integration-status").textContent = "代理已开启，自动切换最快节点。";
    } else {
      checkbox.checked = true;
      state.integrations = await window.jokerdeck.setIntegrations({ officialNetwork: true });
      state.nodeStatus = await window.jokerdeck.nodeConnect();
      startNodeRefresh();
      $("integration-status").textContent = "代理保持开启。";
    }
  } catch (error) {
    if (enabled) {
      try { state.nodeStatus = await window.jokerdeck.nodeDisconnect(); } catch {}
      stopNodeRefresh();
    }
    $("integration-status").textContent = errorText(error);
  } finally {
    checkbox.disabled = true;
    renderNodeStatus();
  }
});
$("computer-use-setting").addEventListener("change", async () => {
  const checkbox = $("computer-use-setting");
  const tool = currentTool();
  const enabled = checkbox.checked;
  checkbox.disabled = true;
  $("integration-status").textContent = "正在配置 MCP…";
  try {
    state.integrations = await window.jokerdeck.setIntegrations({
      tool,
      computerUse: enabled,
    });
    if (currentTool() === tool)
      $("integration-status").textContent = enabled ? "MCP 已启用" : "MCP 已关闭";
  } catch (error) {
    if (currentTool() === tool) $("integration-status").textContent = errorText(error);
  } finally {
    checkbox.checked = Boolean(state.integrations.computerUse?.[currentTool()]);
    checkbox.disabled = !state.capabilities?.computerUseMcp;
  }
});
$("computer-use-permissions").addEventListener("click", async () => {
  try {
    await window.jokerdeck.computerUsePermissions();
    $("integration-status").textContent = "请允许 Open Computer Use 使用辅助功能与录屏；无需启用内核扩展";
  } catch (error) {
    $("integration-status").textContent = errorText(error);
  }
});

async function chooseFastestEndpoint(selectFastest = true) {
  if (!state.endpoints.length) return;
  $("health-status").textContent = "测速中…";
  $("test-endpoints").disabled = true;
  try {
    state.endpoints = await window.jokerdeck.healthCheck(state.endpoints);
    const live = state.endpoints
      .filter((entry) => entry.ok && entry.latency != null)
      .sort((a, b) => a.latency - b.latency);
    const savedEndpoint = state.selectedEndpoint && state.endpoints.find(
      (entry) => entry.endpoint === state.selectedEndpoint.endpoint,
    );
    state.selectedEndpoint = selectFastest
      ? live[0] || savedEndpoint || state.endpoints.find((entry) => entry.endpoint.includes("jokerdeck.de5.net")) || state.endpoints[0]
      : savedEndpoint || live[0] || state.endpoints.find((entry) => entry.endpoint.includes("jokerdeck.de5.net")) || state.endpoints[0];
    renderEndpoints();
    updateSummary();
    const selectedLatency = state.selectedEndpoint?.latency;
    $("health-status").textContent = selectedLatency != null
      ? `已选择 ${selectedLatency} ms`
      : live.length ? "已保留当前线路" : "使用默认线路";
  } finally {
    $("test-endpoints").disabled = false;
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  button.textContent = "正在登录…";
  try {
    const result = state.tempToken
      ? await window.jokerdeck.verifyTwoFactor({
          tempToken: state.tempToken,
          code: $("totp-code").value.trim(),
        })
      : await window.jokerdeck.login({
          email: $("email").value.trim(),
          password: $("password").value,
          rememberLogin: $("remember-login").checked,
        });
    if (result.twoFactor) {
      state.tempToken = result.tempToken;
      $("totp-label").classList.remove("hidden");
      $("totp-code").required = true;
      $("password").disabled = true;
      $("email").disabled = true;
      return;
    }
    $("account").textContent = result.user?.email || "已登录";
    $("logout").classList.remove("hidden");
    $("password").value = "";
    $("totp-code").value = "";
    await loadSetup();
  } catch (error) {
    $("login-error").textContent = errorText(error);
  } finally {
    button.disabled = false;
    button.innerHTML = state.tempToken
      ? "验证并继续 <span>→</span>"
      : "登录并读取配置 <span>→</span>";
  }
});
$("remember-login").addEventListener("change", () => {
  window.jokerdeck.setLoginPreference($("remember-login").checked).catch((error) => {
    $("login-error").textContent = errorText(error);
  });
});
$("logout").addEventListener("click", async () => {
  $("logout").disabled = true;
  try {
    await window.jokerdeck.logout();
    state.catalog = null;
    state.selectedGroup = null;
    state.selectedGroups = {};
    state.tempToken = null;
    $("account").textContent = "未登录";
    $("logout").classList.add("hidden");
    $("email").disabled = false;
    $("password").disabled = false;
    $("password").value = "";
    $("totp-code").value = "";
    $("totp-code").required = false;
    $("totp-label").classList.add("hidden");
    $("remember-login").checked = false;
    $("login-error").textContent = "已退出客户端账号。本机 Codex 和 Claude Code 中已保存的 API Key 仍然有效。";
    show("login-view");
  } catch (error) {
    $("setup-error").textContent = errorText(error);
  } finally {
    $("logout").disabled = false;
  }
});

async function openUpdateDialog(force = false) {
  $("update-status").textContent = "正在检查更新…";
  $("download-update").classList.add("hidden");
  if (force) $("update-dialog").classList.remove("hidden");
  try {
    const update = await window.jokerdeck.checkUpdate();
    state.update = update;
    $("update-trigger").classList.toggle("hidden", !update.available);
    if (!update.available && !force) return;
    $("update-dialog").classList.remove("hidden");
    $("update-version").textContent = `当前 v${update.currentVersion} · 最新 v${update.latestVersion}`;
    $("update-notes").textContent = update.notes || "暂无更新说明";
    $("update-status").textContent = update.available
      ? update.installable ? "安装包可下载，下载后将校验文件。" : "新版本安装包尚未完成发布。"
      : "当前已是最新版本。";
    $("download-update").classList.toggle("hidden", !update.available || !update.installable);
  } catch (error) {
    if (!force) return;
    $("update-status").textContent = errorText(error);
  }
}
$("check-update").addEventListener("click", () => openUpdateDialog(true));
$("update-trigger").addEventListener("click", () => openUpdateDialog(true));
$("close-update").addEventListener("click", () => $("update-dialog").classList.add("hidden"));
$("update-dialog").addEventListener("click", (event) => {
  if (event.target === $("update-dialog")) $("update-dialog").classList.add("hidden");
});
$("download-update").addEventListener("click", async () => {
  const button = $("download-update");
  button.disabled = true;
  $("update-status").textContent = "正在下载…";
  const unsubscribe = window.jokerdeck.onDownloadProgress(({ received, total }) => {
    $("update-status").textContent = total
      ? `正在下载 ${Math.min(100, Math.floor(received / total * 100))}%`
      : `已下载 ${(received / 1048576).toFixed(1)} MB`;
  });
  try {
    await window.jokerdeck.downloadUpdate();
    $("update-status").textContent = "安装包已打开，请按系统提示完成安装。";
  } catch (error) {
    $("update-status").textContent = errorText(error);
  } finally {
    unsubscribe();
    button.disabled = false;
  }
});
$("refresh").addEventListener("click", () =>
  loadSetup().catch((error) => {
    $("setup-error").textContent = errorText(error);
  }),
);
$("test-endpoints").addEventListener("click", chooseFastestEndpoint);
document
  .querySelectorAll("[data-category]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      setCategory(button.dataset.category),
    ),
  );
$("launch-progress-close").addEventListener("click", () => {
  $("launch-progress").classList.add("hidden");
  $("launch-progress-close").classList.add("hidden");
});
$("launch").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  $("launch").disabled = true;
  $("launch").innerHTML = "正在配置…";
  const tool = currentTool();
  let currentStep = "check";
  openLaunchProgress(tool);
  try {
    updateLaunchProgress("check", "active", `正在检查 ${currentAppName()} 是否可用`);
    const capabilities = await window.jokerdeck.capabilities();
    if (!capabilities[tool].installed)
      throw new Error(`未检测到 ${currentAppName()}，请先安装官方客户端`);
    updateLaunchProgress("check", "done", capabilities[tool].version ? `已检测到 ${capabilities[tool].version}` : "客户端已安装");

    currentStep = "route";
    updateLaunchProgress("route", "active", "正在测试线路响应时间");
    await chooseFastestEndpoint(false);
    updateLaunchProgress(
      "route",
      "done",
      state.selectedEndpoint
        ? `已选择 ${state.selectedEndpoint.name} · ${state.selectedEndpoint.endpoint}${state.selectedEndpoint.latency == null ? "" : `（${state.selectedEndpoint.latency} ms）`}`
        : "未配置线路，将使用默认地址",
    );

    const officialNetwork = tool === "codex" && Boolean(state.integrations.officialNetwork);
    currentStep = "key";
    if (!state.selectedGroup)
      throw new Error("请先选择一个分组");
    let apiKey = "";
    let keyCreated = false;
    updateLaunchProgress("key", "active", `正在准备 ${state.selectedGroup.name} 的专用密钥`);
    apiKey = await window.jokerdeck.configuredKey({
      groupId: state.selectedGroup.id,
      tool,
    });
    if (!apiKey) {
      const key = await window.jokerdeck.createKey({
        groupId: state.selectedGroup.id,
        name: `jokerdeck-client-${state.selectedGroup.id}`,
      });
      apiKey = key?.key || key?.api_key || key?.token || key?.custom_key || key?.data?.key || key?.data?.api_key || key?.data?.token || key?.data?.custom_key;
      keyCreated = Boolean(apiKey);
    }
    if (!apiKey) throw new Error("服务端未返回新密钥，请到 API 密钥页确认");
    updateLaunchProgress("key", "done", `${keyCreated ? "已创建新的分组专用 API Key" : "已找到并沿用现有分组 API Key"} · ${maskSecret(apiKey)}`);
    addLaunchChange(`${state.selectedGroup.name}：${keyCreated ? "创建并使用新的" : "沿用现有"} API Key`);
    if (officialNetwork) addLaunchChange("模型请求使用中转配置，网络出口使用常驻代理");

    state.useV1 = $("gpt-v1-routing").checked;
    currentStep = "write";
    updateLaunchProgress("write", "active", "正在写入本地 provider 配置和本次选择");
    const saved = await window.jokerdeck.savePreferences({
      selectedGroup: state.selectedGroup,
      selectedEndpoint: state.selectedEndpoint,
      category: state.category,
      tool,
      apiKey,
      officialNetwork,
      useV1: state.useV1,
    });
    state.activeConfig = {
      ...(state.activeConfig || {}),
      groupId: state.selectedGroup?.id,
      group: state.selectedGroup?.name || "",
      category: state.category,
      tool,
      mode: officialNetwork ? "official-node-relay" : "relay",
      route: state.selectedEndpoint?.endpoint || "",
      endpoint: saved?.endpoint || state.selectedEndpoint?.endpoint || "",
      apiKey,
      configPath: saved?.configPath || "",
      provider: "custom",
      wireApi: "responses",
      requiresOpenAiAuth: false,
    };
    state.configured = { ...state.activeConfig };
    renderConfigured();
    updateLaunchProgress("write", "done", saved?.configPath ? `已写入 ${saved.configPath} · ${saved.endpoint}` : `本地配置已写入 · ${saved?.endpoint || "默认地址"}`);
    addLaunchChange(`${state.selectedGroup?.name || "官方 Codex"} · ${state.selectedEndpoint?.name || "默认线路"}`);
    if (saved?.configPath) addLaunchChange(`配置文件：${saved.configPath}`);

    currentStep = "start";
    updateLaunchProgress("start", "active", `正在启动 ${currentAppName()}`);
    const launchResult = tool === "claude"
      ? await window.jokerdeck.launchClaude()
      : await window.jokerdeck.launchCodex({
          localized: state.integrations.localization !== false,
          officialNetwork: Boolean(state.integrations.officialNetwork),
        });
    state.nodeStatus = await window.jokerdeck.nodeStatus();
    renderNodeStatus();
    if (launchResult?.cancelled) {
      updateLaunchProgress("start", "failed", "已保存配置，但你取消了重启");
      finishLaunchProgress(false, "配置已经保存；关闭此窗口后可再次点击启动，让新配置生效。");
      $("setup-error").textContent = "已保存配置；已取消重启 Codex。";
      $("launch").disabled = false;
      $("launch").innerHTML = `配置并启动 ${currentAppName()} <span>→</span>`;
      updateSummary();
      return;
    }
    updateLaunchProgress("start", "done", `${currentAppName()} 已启动`);
    finishLaunchProgress(true);
    await new Promise((resolve) => setTimeout(resolve, 280));
    $("launch-progress").classList.add("hidden");
    $("success-text").textContent =
      `${state.selectedGroup?.name || "官方 Codex"} 已保存，${officialNetwork ? "模型请求使用中转配置，网络出口使用常驻代理" : `${state.selectedEndpoint?.name || "默认线路"} 已写入 ${saved?.configPath || "本地配置"}`}，正在打开 ${currentAppName()}。${launchResult?.warning || ""}`;
    renderSuccessConfig();
    $("success-view").querySelector("h1").textContent =
      `${currentAppName()} 正在启动`;
    $("launch-again").innerHTML = `再次启动 ${currentAppName()} <span>→</span>`;
    show("success-view");
  } catch (error) {
    $("setup-error").textContent = errorText(error);
    updateLaunchProgress(currentStep, "failed", errorText(error));
    finishLaunchProgress(false, errorText(error));
    $("launch").disabled = false;
    $("launch").innerHTML = `配置并启动 ${currentAppName()} <span>→</span>`;
    updateSummary();
  }
});
$("launch-again").addEventListener("click", async () => {
  $("success-error").textContent = "";
  try {
    if (currentTool() === "claude") await window.jokerdeck.launchClaude();
    else {
      const result = await window.jokerdeck.launchCodex({
        localized: state.integrations.localization !== false,
        officialNetwork: Boolean(state.integrations.officialNetwork),
      });
      if (result?.cancelled) $("success-error").textContent = "已取消重启 Codex。";
    }
  } catch (error) {
    $("success-error").textContent = errorText(error);
  }
});
$("back-to-setup").addEventListener("click", () => show("setup-view"));
$("site-link").addEventListener("click", () =>
  window.jokerdeck.openUrl("https://jokerdeck.de5.net/dashboard"),
);
(async () => {
  try {
    $("app-version").textContent = `v${await window.jokerdeck.appVersion()}`;
    openUpdateDialog().catch(() => {});
    const session = await window.jokerdeck.session();
    state.integrations = session.integrations || { localization: true, computerUse: { codex: true, claude: false }, officialNetwork: true };
    state.activeConfig = session.activeConfig || null;
    if (state.activeConfig) state.configured = { ...state.configured, ...state.activeConfig };
    $("remember-login").checked = session.rememberLogin !== false;
    if (session.token) {
      $("account").textContent = session.user?.email || "已登录";
      $("logout").classList.remove("hidden");
      try {
        state.selectedGroups = session.selectedGroups || {};
        state.useV1 = session.useV1 !== false;
        $("gpt-v1-routing").checked = state.useV1;
        state.selectedEndpoint = session.selectedEndpoint;
        state.selectedGroup = state.selectedGroups[state.category] || null;
        await loadSetup();
        renderEndpoints();
        updateSummary();
      } catch {
        $("logout").classList.add("hidden");
        $("account").textContent = "未登录";
        show("login-view");
      }
    }
  } catch (error) {
    $("login-error").textContent = errorText(error);
  } finally {
    document.body.classList.remove("booting");
  }
})();

$("gpt-v1-routing").addEventListener("change", () => {
  state.useV1 = $("gpt-v1-routing").checked;
});
$("reveal-key").addEventListener("click", () => {
  const node = $("configured-key");
  node.dataset.revealed = node.dataset.revealed === "true" ? "false" : "true";
  renderConfigured();
});
$("copy-config").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText([
      `group=${state.configured.group || state.selectedGroup?.name || ""}`,
      `route=${state.configured.route || state.selectedEndpoint?.endpoint || ""}`,
      `endpoint=${state.configured.endpoint || ""}`,
      `api_key=${state.configured.apiKey || ""}`,
      `provider=${state.configured.provider || "custom"}`,
      `wire_api=${state.configured.wireApi || "responses"}`,
      `requires_openai_auth=${Boolean(state.configured.requiresOpenAiAuth)}`,
      `config_path=${state.configured.configPath || ""}`,
    ].join("\n"));
    $("integration-status").textContent = "诊断信息已复制";
  } catch {
    $("integration-status").textContent = "复制失败，请检查系统剪贴板权限";
  }
});
