/**
 * fetch with AbortController timeout. Never logs response bodies (may contain secrets).
 */
const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId =
    controller != null
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller ? controller.signal : options.signal,
    });
    return response;
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeoutError = new Error(`Store request timed out after ${timeoutMs}ms`);
      timeoutError.code = "STORE_TIMEOUT";
      throw timeoutError;
    }
    throw err;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
};

module.exports = { fetchWithTimeout };
