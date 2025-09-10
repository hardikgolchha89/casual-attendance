// Configure endpoints for local development and production (Google Apps Script)
function getQueryParam(name) {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

const manualEndpoint = (() => getQueryParam("endpoint"))();
const autoLocal = (() => {
  try {
    if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname)) {
      const port = getQueryParam("apiPort") || "8787";
      return `http://localhost:${port}/log`;
    }
  } catch {}
  return "";
})();

export const CONFIG = {
  // Priority: endpoint query param > localhost auto > static value
  sheetsEndpoint: manualEndpoint || autoLocal || "",
  requestTimeoutMs: 12000
};
