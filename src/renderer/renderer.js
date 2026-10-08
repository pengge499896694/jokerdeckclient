const state = {
  catalog: null,
  selectedGroup: null,
  selectedEndpoint: null,
  endpoints: [],
  tempToken: null,
  category: "openai",
  selectedGroups: {},
  update: null,
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
        `<div class="endpoint-row ${state.selectedEndpoint?.endpoint === entry.endpoint ? "active" : ""}"><div><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.description || entry.endpoint)}</small></div><span class="endpoint-latency">${entry.latency == null ? "待测速" : `${entry.latency} ms`}</span></div>`,
    )
    .join("");
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
    [
      "Computer Use",
      data.computerUse.enabled
        ? "插件已启用 · 权限由官方控制"
        : data.computerUse.installed
          ? "已安装 · 需在 Codex 启用"
          : "未安装插件",
    ],
    ["中文界面", "客户端已启用"],
    ["本地配置", data.configExists ? "已发现 config.toml" : "首次配置"],
  ]
    .map(
      ([label, value]) =>
        `<div class="capability-row"><span>${label}</span><span class="${value.includes("未") || value.includes("需要") ? "warn" : "good"}">${value}</span></div>`,
    )
    .join("");
}
function updateSummary() {
  $("selection-summary").textContent = state.selectedGroup
    ? `${state.selectedGroup.name} · ${state.selectedEndpoint?.name || "线路自动选择"}`
    : "请选择一个分组";
  $("launch").disabled = !state.selectedGroup;
  $("launch").innerHTML = `配置并启动 ${currentAppName()} <span>→</span>`;
}
function setCategory(category) {
  state.category = category;
  state.selectedGroup = state.selectedGroups[category] || null;
  document.querySelectorAll("[data-category]").forEach((button) => {
    const active = button.dataset.category === category;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderGroups();
  updateSummary();
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
      state.catalog.groups.find((group) => group.id === savedId) || null;
  }
  setCategory(state.category);
  renderEndpoints();
  updateSummary();
  renderCapabilities(await window.jokerdeck.capabilities());
  show("setup-view");
  chooseFastestEndpoint();
}

async function chooseFastestEndpoint() {
  if (!state.endpoints.length) return;
  $("health-status").textContent = "测速中…";
  $("test-endpoints").disabled = true;
  try {
    state.endpoints = await window.jokerdeck.healthCheck(state.endpoints);
    const live = state.endpoints
      .filter((entry) => entry.ok && entry.latency != null)
      .sort((a, b) => a.latency - b.latency);
    state.selectedEndpoint =
      live[0] ||
      state.endpoints.find((entry) =>
        entry.endpoint.includes("jokerdeck.de5.net"),
      ) ||
      state.endpoints[0];
    renderEndpoints();
    updateSummary();
    $("health-status").textContent = live.length
      ? `已选择 ${state.selectedEndpoint.latency} ms`
      : "使用默认线路";
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
$("launch").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  $("launch").disabled = true;
  $("launch").innerHTML = "正在配置…";
  try {
    const tool = currentTool();
    const capabilities = await window.jokerdeck.capabilities();
    if (!capabilities[tool].installed)
      throw new Error(`未检测到 ${currentAppName()}，请先安装官方客户端`);
    await chooseFastestEndpoint();
    let apiKey = await window.jokerdeck.configuredKey({
      groupId: state.selectedGroup.id,
      tool,
    });
    if (!apiKey) {
      const key = await window.jokerdeck.createKey({
        groupId: state.selectedGroup.id,
        name: `jokerdeck-client-${state.selectedGroup.id}`,
      });
      apiKey = key.key || key.api_key || key.token || key.custom_key;
    }
    if (!apiKey) throw new Error("服务端未返回新密钥，请到 API 密钥页确认");
    await window.jokerdeck.savePreferences({
      selectedGroup: state.selectedGroup,
      selectedEndpoint: state.selectedEndpoint,
      category: state.category,
      tool,
      apiKey,
    });
    if (tool === "claude") await window.jokerdeck.launchClaude();
    else await window.jokerdeck.launchCodex();
    $("success-text").textContent =
      `${state.selectedGroup.name} 已写入本机配置，正在打开 ${currentAppName()}。`;
    $("success-view").querySelector("h1").textContent =
      `${currentAppName()} 正在启动`;
    $("launch-again").innerHTML = `再次启动 ${currentAppName()} <span>→</span>`;
    show("success-view");
  } catch (error) {
    $("setup-error").textContent = errorText(error);
    $("launch").disabled = false;
    updateSummary();
  }
});
$("launch-again").addEventListener("click", () =>
  currentTool() === "claude"
    ? window.jokerdeck.launchClaude()
    : window.jokerdeck.launchCodex(),
);
$("back-to-setup").addEventListener("click", () => show("setup-view"));
$("site-link").addEventListener("click", () =>
  window.jokerdeck.openUrl("https://jokerdeck.de5.net/dashboard"),
);
(async () => {
  $("app-version").textContent = `v${await window.jokerdeck.appVersion()}`;
  openUpdateDialog().catch(() => {});
  const session = await window.jokerdeck.session();
  $("remember-login").checked = session.rememberLogin !== false;
  if (session.token) {
    $("account").textContent = session.user?.email || "已登录";
    $("logout").classList.remove("hidden");
    try {
      state.selectedGroups = session.selectedGroups || {};
      state.selectedGroup = state.selectedGroups[state.category] || null;
      await loadSetup();
      state.selectedEndpoint = session.selectedEndpoint;
      renderEndpoints();
      updateSummary();
    } catch {
      $("logout").classList.add("hidden");
      $("account").textContent = "未登录";
      show("login-view");
    }
  }
})();
