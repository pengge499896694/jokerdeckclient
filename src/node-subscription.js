const YAML = require("yaml");

const DEFAULT_SUBSCRIPTION_URL = "https://234.qzz.io/fsllistyaml";
const SUPPORTED_COUNTRIES = new Set([
  "US", "CA", "GB", "DE", "FR", "NL", "CH", "FI", "JP", "KR", "SG", "RO",
]);
const PROXY_TYPES = new Set(["http", "socks5", "ss", "vmess", "vless", "trojan", "hysteria2", "tuic"]);

function subscriptionUrl(value) {
  let url;
  try {
    url = new URL(value || DEFAULT_SUBSCRIPTION_URL);
  } catch {
    throw new Error("节点订阅地址无效，必须填写完整的 HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("节点订阅必须是无账号信息的 HTTPS 地址");
  return url.href;
}

function normalizeNodePolicy(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("节点策略格式无效");
  const subscription = raw.subscription_url ?? raw.subscriptionUrl ?? raw.url;
  return {
    enabled: raw.enabled !== false,
    subscriptionUrl: subscriptionUrl(subscription),
    disabledNodes: Array.isArray(raw.disabled_nodes)
      ? raw.disabled_nodes.filter((name) => typeof name === "string" && name.length <= 120)
      : [],
    pinnedNode: typeof raw.pinned_node === "string" ? raw.pinned_node : "",
  };
}

function parseNodes(source, { disabled = [], countryCodes = SUPPORTED_COUNTRIES } = {}) {
  if (typeof source !== "string" || source.length > 1024 * 1024)
    throw new Error("节点订阅内容无效或过大");
  const document = YAML.parse(source, { maxAliasCount: 0 });
  if (!document || !Array.isArray(document.proxies)) throw new Error("节点订阅缺少 proxies 列表");
  const blocked = new Set(disabled);
  const countries = new Set(countryCodes);
  const names = new Set();
  return document.proxies.filter((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const country = String(node.name || "").match(/^([A-Z]{2})-/)?.[1];
    if (!countries.has(country) || blocked.has(node.name) || names.has(node.name)) return false;
    if (!PROXY_TYPES.has(node.type) || typeof node.server !== "string" || !node.server ||
      !Number.isInteger(node.port) || node.port < 1 || node.port > 65535 ||
      typeof node.name !== "string" || node.name.length > 120) return false;
    names.add(node.name);
    return true;
  });
}

function buildCoreConfig(nodes, port, pinnedNode = "", controllerPort = 0) {
  if (!nodes.length) throw new Error("订阅中没有可用的候选节点");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("本机代理端口无效");
  if (pinnedNode && !nodes.some((node) => node.name === pinnedNode))
    throw new Error("指定节点已停用或不在当前订阅中");
  const selected = pinnedNode ? nodes.filter((node) => node.name === pinnedNode) : nodes;
  const config = {
    "mixed-port": port,
    ...(Number.isInteger(controllerPort) && controllerPort >= 1024 && controllerPort <= 65535
      ? { "external-controller": `127.0.0.1:${controllerPort}` }
      : {}),
    "allow-lan": false,
    "bind-address": "127.0.0.1",
    mode: "rule",
    "log-level": "warning",
    "unified-delay": true,
    proxies: selected,
    "proxy-groups": [{
      name: "JOKERDECK",
      type: "select",
      proxies: selected.map((node) => node.name),
    }],
    rules: ["MATCH,JOKERDECK"],
  };
  return YAML.stringify(config);
}

module.exports = { DEFAULT_SUBSCRIPTION_URL, SUPPORTED_COUNTRIES, subscriptionUrl, normalizeNodePolicy, parseNodes, buildCoreConfig };
