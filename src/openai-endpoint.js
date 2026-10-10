function normalizeOpenAiEndpoint(endpoint, useV1 = true) {
  let url;
  try {
    url = new URL(endpoint || "https://jokerdeck.de5.net");
  } catch {
    throw new Error("GPT API 地址无效");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("GPT API 地址必须使用 HTTPS 或 HTTP");
  const pathName = url.pathname.replace(/\/+$/, "");
  if (useV1 && pathName.split("/").pop()?.toLowerCase() !== "v1") url.pathname = `${pathName}/v1`;
  else url.pathname = pathName || "/";
  return url.href.replace(/\/$/, "");
}

function extractApiKey(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.key || value.api_key || value.token || value.custom_key ||
    value.data?.key || value.data?.api_key || value.data?.token || value.data?.custom_key || "";
}

module.exports = { normalizeOpenAiEndpoint, extractApiKey };
