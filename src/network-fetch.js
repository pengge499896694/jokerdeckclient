const RETRYABLE_CODES = new Set([
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_REFUSED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
]);

function isRetryableNetworkError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return RETRYABLE_CODES.has(code) || /ERR_CONNECTION_(?:CLOSED|RESET|REFUSED)/i.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryingFetch(fetchImpl, input, options = {}, { retries = 2, backoff = 350 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchImpl(input, options);
    } catch (error) {
      if (attempt >= retries || options.signal?.aborted || !isRetryableNetworkError(error)) throw error;
      await delay(backoff * (attempt + 1));
    }
  }
}

function nodeConnectionError(error) {
  if (isRetryableNetworkError(error)) {
    return new Error("节点连接被远端关闭，请稍后重试；如果持续失败，请检查节点订阅或中转站服务");
  }
  return error;
}

module.exports = { isRetryableNetworkError, retryingFetch, nodeConnectionError };
