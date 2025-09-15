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
const defaultEndpoint = "https://script.google.com/macros/s/AKfycbwJ_3nYJX_ZzTAJRvtAy8l1TWV3t1m37Y2ECSfK7RFcijJOyOgBlzq-Gr-1bga25K3PEw/exec";
const autoLocal = ""; // disabled: always use manual or default endpoint

export const CONFIG = {
  // Priority: endpoint query param > static value (localhost disabled)
  sheetsEndpoint: manualEndpoint || defaultEndpoint,
  requestTimeoutMs: 12000
};
