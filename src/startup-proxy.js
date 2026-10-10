const net = require("node:net");
const tls = require("node:tls");

function normalizeLocalProxy(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("请填写本机 HTTP 代理地址");
  let url;
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    throw new Error("代理地址格式无效，请填写 127.0.0.1:端口");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) throw new Error("仅支持带端口的本机 HTTP 代理，例如 127.0.0.1:7877");
  return url.origin;
}

function systemProxySuggestion(resolution) {
  for (const entry of String(resolution || "").split(";")) {
    const match = entry.trim().match(/^PROXY\s+(\S+)$/i);
    if (!match) continue;
    try {
      return normalizeLocalProxy(match[1]);
    } catch {}
  }
  return "";
}

function proxyServerArgument(input) {
  return `--proxy-server=${normalizeLocalProxy(input)}`;
}

function proxiedDesktopEnvironment(input, base = process.env) {
  const address = normalizeLocalProxy(input);
  return {
    ...base,
    HTTP_PROXY: address, HTTPS_PROXY: address, ALL_PROXY: address,
    http_proxy: address, https_proxy: address, all_proxy: address,
    NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
  };
}

function checkLocalProxy(input, timeout = 5000) {
  const url = new URL(normalizeLocalProxy(input));
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname.replace(/^\[|\]$/g, ""));
    let settled = false;
    let response = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(true);
    };
    socket.setTimeout(timeout, () => finish(new Error("本机代理连接超时，请检查节点程序")));
    socket.on("connect", () => {
      socket.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("ascii");
      if (response.length > 4096) return finish(new Error("本机代理响应无效"));
      const firstLine = response.split("\r\n", 1)[0];
      if (!response.includes("\r\n")) return;
      if (/^HTTP\/1\.[01] 200(?:\s|$)/.test(firstLine)) finish();
      else finish(new Error(`本机代理无法连接 ChatGPT：${firstLine}`));
    });
    socket.on("error", () => finish(new Error("无法连接本机代理，请确认节点程序正在运行")));
    socket.on("end", () => finish(new Error("本机代理未响应 CONNECT 请求")));
  });
}

function probeOfficialProxy(input, timeout = 10000) {
  const url = new URL(normalizeLocalProxy(input));
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname.replace(/^\[|\]$/g, ""));
    let secureSocket;
    let settled = false;
    let response = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      secureSocket?.destroy();
      socket.destroy();
      if (error) reject(error);
      else resolve(true);
    };
    socket.setTimeout(timeout, () => finish(new Error("节点访问官方站点超时，请更换节点")));
    socket.on("error", () => finish(new Error("本机代理连接失败")));
    socket.on("connect", () => {
      socket.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n");
    });
    const onConnectResponse = (chunk) => {
      response += chunk.toString("ascii");
      if (response.length > 4096) return finish(new Error("节点 CONNECT 响应无效"));
      if (!response.includes("\r\n\r\n")) return;
      const firstLine = response.split("\r\n", 1)[0];
      if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(firstLine))
        return finish(new Error(`节点无法连接官方站点：${firstLine}`));
      socket.removeListener("data", onConnectResponse);
      secureSocket = tls.connect({ socket, servername: "chatgpt.com", ALPNProtocols: ["http/1.1"] });
      secureSocket.setTimeout(timeout, () => finish(new Error("节点与官方站点的 TLS 连接超时")));
      secureSocket.on("error", (error) => finish(new Error(`节点与官方站点的 TLS 连接失败：${error.message}`)));
      secureSocket.on("secureConnect", () => {
        secureSocket.write("GET /cdn-cgi/trace HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n");
      });
      let officialResponse = "";
      secureSocket.on("data", (data) => {
        officialResponse += data.toString("utf8");
        if (officialResponse.length > 8192) return finish(new Error("官方站点响应无效"));
        if (!officialResponse.includes("\r\n\r\n")) return;
        const status = officialResponse.match(/^HTTP\/1\.[01] (\d{3})/);
        if (!status) return finish(new Error("官方站点响应无效"));
        if (Number(status[1]) >= 200 && Number(status[1]) < 400) finish();
        else finish(new Error(`节点访问官方站点返回 ${status[1]}，请更换节点`));
      });
      secureSocket.on("end", () => finish(new Error("官方站点未返回 HTTP 响应")));
    };
    socket.on("data", onConnectResponse);
    socket.on("end", () => finish(new Error("节点未完成 CONNECT 连接")));
  });
}

module.exports = { normalizeLocalProxy, systemProxySuggestion, proxyServerArgument, proxiedDesktopEnvironment, checkLocalProxy, probeOfficialProxy };
