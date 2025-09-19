import { CONFIG } from "./config.js";
// Register service worker for PWA
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

const btnCheckIn = document.getElementById("btn-checkin");
const btnCheckOut = document.getElementById("btn-checkout");
const modalEl = document.getElementById("scanner-modal");
const modalBackdropEl = document.getElementById("scanner-backdrop");
const modalCloseEl = document.getElementById("scanner-close");
const modalCancelEl = document.getElementById("scanner-cancel");
const modalTitleEl = document.getElementById("scanner-title");
const toastContainer = document.getElementById("toast-container");
const cameraSelectEl = document.getElementById("camera-select");
// QR generator elements
const qrGenNameEl = document.getElementById("qrgen-name");
const qrGenLocationEl = document.getElementById("qrgen-location");
const qrGenBtnEl = document.getElementById("qrgen-generate");
const qrGenDlBtnEl = document.getElementById("qrgen-download");
const qrGenPreviewEl = document.getElementById("qrgen-preview");
// Bulk generator elements
const bulkFileEl = document.getElementById("bulk-file");
const bulkTextEl = document.getElementById("bulk-text");
const bulkGenBtnEl = document.getElementById("bulk-generate");
// Site selector
const siteInputEl = document.getElementById("site-input");
const SITE_KEY = "attendance:site";
// Tabs
const tabScanBtn = document.getElementById("tab-scan");
const tabGenBtn = document.getElementById("tab-generate");
const sectionScan = document.getElementById("section-scan");
const sectionGen = document.getElementById("section-generate");
const tabAnalyticsBtn = document.getElementById("tab-analytics");
const sectionAnalytics = document.getElementById("section-analytics");

let html5QrCode = null;
let isScanning = false;
let currentAction = null; // "Check In" | "Check Out"
let availableCameras = [];
let currentCameraId = null;
let wakeLock = null;
const isCapacitor = typeof window !== "undefined" && !!window.Capacitor && !!window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
// Generation rate limiting
const GENERATE_COOLDOWN_MS = 3000; // 3 seconds
let lastSingleGenerateAt = 0;
let lastBulkGenerateAt = 0;

const LAST_CAMERA_KEY = "attendance:lastCameraId";
function ensureHtml5QrcodeLoaded() {
  return new Promise((resolve, reject) => {
    try {
      if (typeof window !== "undefined" && window.Html5Qrcode) {
        return resolve();
      }
      // Already included via local vendor script in index.html; if blocked, we can't auto-load.
      // Wait a tick in case the script hasn't executed yet.
      setTimeout(() => {
        if (typeof window !== "undefined" && window.Html5Qrcode) return resolve();
        reject(new Error("html5-qrcode not available"));
      }, 50);
    } catch (e) {
      reject(e);
    }
  });
}

async function openScanner(actionLabel) {
  if (isScanning) return;
  currentAction = actionLabel;
  modalTitleEl.textContent = `Scan QR — ${actionLabel}`;
  modalEl.setAttribute("aria-hidden", "false");
  if (isCapacitor) {
    try {
      await scanWithNativeScanner();
      return;
    } catch (e) {
      console.error("Native scan failed, falling back to web", e);
      // fall through to web scanner
    }
  }
  try {
    await ensureHtml5QrcodeLoaded();
    await setupCameraPicker();
  } catch (err) {
    console.error("Camera setup failed", err);
    showToast("❌ Camera library failed to load. Hard refresh and ensure no blockers.", "error");
  }
  startScanner(currentCameraId);
}

function closeScanner() {
  stopScanner();
  modalEl.setAttribute("aria-hidden", "true");
  if (cameraSelectEl) {
    cameraSelectEl.innerHTML = "";
  }
}

function startScanner(cameraId) {
  const qrRegionId = "qr-reader";
  // Prefer faster detection settings where supported
  const config = { fps: 15, qrbox: { width: 300, height: 300 }, aspectRatio: 1.0, rememberLastUsedCamera: true };
  try {
    // Limit to QR only if the enum exists
    // eslint-disable-next-line no-undef
    if (typeof Html5QrcodeSupportedFormats !== "undefined" && Html5QrcodeSupportedFormats.QR_CODE) {
      // eslint-disable-next-line no-undef
      config.formatsToSupport = [Html5QrcodeSupportedFormats.QR_CODE];
    }
  } catch (_) {
    // ignore if not available
  }
  config.experimentalFeatures = { useBarCodeDetectorIfSupported: true };
  html5QrCode = new Html5Qrcode(qrRegionId);
  isScanning = true;
  acquireWakeLock();

  const cameraConfig = cameraId ? cameraId : { facingMode: "environment" };

  html5QrCode.start(
    cameraConfig,
    config,
    (decodedText) => {
      if (!decodedText) return;
      // Stop scanning immediately to prevent multiple reads
      stopScanner();

      const now = new Date();
      const iso = now.toISOString();
      const dateStr = iso.slice(0, 10); // YYYY-MM-DD
      const timeStr = now.toLocaleTimeString([], { hour12: false });

      const payload = {
        workerId: decodedText.trim(),
        date: dateStr,
        time: timeStr,
        action: currentAction,
      };

      // Close UI immediately for responsiveness
      closeScanner();
      showToast("✅ Scanned, saving...", "success");
      // Send in background and report result
      sendToSheets(payload)
        .then(() => {
          showToast(`✅ ${currentAction === "Check In" ? "Checked In" : "Checked Out"}`, "success");
        })
        .catch((err) => {
          console.error(err);
          showToast("❌ Save failed, please retry.", "error");
        });
    },
    (errorMessage) => {
      // Ignore continuous scan errors
    }
  ).catch((err) => {
    console.error("Scanner start failed", err);
    const msg = String(err || "");
    if (/NotAllowedError|Permission/i.test(msg)) {
      showToast("❌ Camera permission denied. Enable it in browser settings.", "error");
    } else if (/NotFoundError|no camera/i.test(msg)) {
      showToast("❌ No camera found.", "error");
    } else {
      showToast("❌ Scan failed, please try again.", "error");
    }
    closeScanner();
  });
}

function stopScanner() {
  if (!isScanning || !html5QrCode) return;
  const localRef = html5QrCode;
  isScanning = false;
  html5QrCode = null;
  localRef.stop().then(() => {
    localRef.clear();
  }).catch(() => {
    // no-op
  });
  releaseWakeLock();
}

// ===== Native scanner (Capacitor) =====
async function scanWithNativeScanner() {
  // Dynamically import the plugin if available
  const cap = window.Capacitor;
  if (!cap) throw new Error("Capacitor not available");
  const plugin = cap.Plugins && (cap.Plugins.BarcodeScanner || cap.Plugins.BarcodeScannerPlugin);
  if (!plugin) throw new Error("BarcodeScanner plugin not available");

  // Configure and request permission
  if (plugin.prepare) {
    await plugin.prepare();
  }
  if (plugin.checkPermission) {
    const perm = await plugin.checkPermission({ force: true });
    if (!perm.granted) throw new Error("Camera permission not granted");
  }

  // Hide the webview background for better performance
  if (plugin.hideBackground) await plugin.hideBackground();
  try {
    const result = await plugin.startScan({ targetedFormats: ["QR_CODE"] });
    if (!result || !result.hasContent) throw new Error("No content");
    const decodedText = String(result.content || "").trim();
    if (!decodedText) throw new Error("Empty content");

    const now = new Date();
    const iso = now.toISOString();
    const dateStr = iso.slice(0, 10);
    const timeStr = now.toLocaleTimeString([], { hour12: false });
    const payload = { workerId: decodedText, date: dateStr, time: timeStr, action: currentAction };
    closeScanner();
    showToast("✅ Scanned, saving...", "success");
    await sendToSheets(payload);
    showToast(`✅ ${currentAction === "Check In" ? "Checked In" : "Checked Out"}`, "success");
  } finally {
    if (plugin.showBackground) await plugin.showBackground();
    if (plugin.stopScan) await plugin.stopScan();
  }
}

async function setupCameraPicker() {
  if (!cameraSelectEl) return;
  try {
    availableCameras = await Html5Qrcode.getCameras();
  } catch (err) {
    // On some browsers, getCameras may require prior permission. We'll still try default camera.
    availableCameras = [];
  }

  cameraSelectEl.innerHTML = "";
  if (availableCameras && availableCameras.length) {
    const lastId = localStorage.getItem(LAST_CAMERA_KEY);
    availableCameras.forEach((cam) => {
      const opt = document.createElement("option");
      opt.value = cam.id;
      opt.textContent = cam.label || cam.id;
      cameraSelectEl.appendChild(opt);
    });
    // Choose last used, or a back/rear/environment camera if available, else first
    let selectedId = availableCameras.find(c => c.id === lastId)?.id;
    if (!selectedId) {
      const backCam = availableCameras.find(c => /back|rear|environment|world/i.test(c.label || ""));
      selectedId = backCam ? backCam.id : availableCameras[0].id;
    }
    cameraSelectEl.value = selectedId;
    currentCameraId = selectedId;
  } else {
    // No list available; fall back to environment selection
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Default camera";
    cameraSelectEl.appendChild(opt);
    cameraSelectEl.value = "";
    currentCameraId = null;
  }

  cameraSelectEl.onchange = async (e) => {
    const newId = e.target.value || null;
    if (newId === currentCameraId) return;
    currentCameraId = newId;
    localStorage.setItem(LAST_CAMERA_KEY, newId || "");
    // Restart scanner with selected camera
    const wasScanning = isScanning;
    stopScanner();
    if (wasScanning) {
      startScanner(currentCameraId);
    }
  };
}

async function sendToSheets({ workerId, date, time, action }) {
  if (!CONFIG.sheetsEndpoint) {
    throw new Error("Sheets endpoint not configured");
  }
  const site = siteInputEl ? String(siteInputEl.value || "").trim() : "";
  const payload = { workerId, date, time, action, site };
  const body = JSON.stringify(payload);

  // Try as a simple CORS request (text/plain avoids preflight). If response is opaque,
  // assume success because Apps Script often omits ACAO headers.
  const attempt = async (mode) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs || 12000);
    try {
      const res = await fetch(CONFIG.sheetsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body,
        signal: controller.signal,
        mode,
      });
      clearTimeout(timeout);

      if (res.type === "opaque") {
        return { status: "ok" }; // treat as success
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Bad response: ${res.status} ${txt}`);
      }
      const data = await res.json().catch(() => ({}));
      if (!data || data.status !== "ok") {
        throw new Error("Sheets API error");
      }
      return data;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  };

  try {
    return await attempt("cors");
  } catch (e) {
    // Fallback: no-cors (opaque). We cannot read response but server will receive it.
    try {
      return await attempt("no-cors");
    } catch (e2) {
      throw e2;
    }
  }
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "success" ? "toast--success" : "toast--error"}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    setTimeout(() => toast.remove(), 220);
  }, 2200);
}

btnCheckIn.addEventListener("click", () => openScanner("Check In"));
btnCheckOut.addEventListener("click", () => openScanner("Check Out"));
modalBackdropEl.addEventListener("click", closeScanner);
modalCloseEl.addEventListener("click", closeScanner);
modalCancelEl.addEventListener("click", closeScanner);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalEl.getAttribute("aria-hidden") === "false") {
    closeScanner();
  }
});

// ===== QR GENERATOR =====
function sanitizeFileName(name) {
  return String(name || "").trim().replace(/\s+/g, "-").replace(/[^-a-zA-Z0-9_.]/g, "").slice(0, 60) || "QR";
}

function generateQr() {
  const now = Date.now();
  if (now - lastSingleGenerateAt < GENERATE_COOLDOWN_MS) {
    const waitMs = GENERATE_COOLDOWN_MS - (now - lastSingleGenerateAt);
    showToast(`Please wait ${Math.ceil(waitMs / 1000)}s before generating again`, "error");
    return;
  }
  const name = (qrGenNameEl && qrGenNameEl.value) ? qrGenNameEl.value.trim() : "";
  const location = (qrGenLocationEl && qrGenLocationEl.value) ? qrGenLocationEl.value.trim() : "";
  if (!name) {
    showToast("Please enter Name", "error");
    return;
  }
  if (!qrGenPreviewEl) return;
  qrGenPreviewEl.innerHTML = "";
  // qrcodejs attaches to a container element
  const size = 280;
  /* global QRCode */
  try {
    // eslint-disable-next-line no-undef
    const qrcode = new QRCode(qrGenPreviewEl, {
      // Encode Name_Location so WorkerID becomes Name_Location when scanned
      text: location ? `${name}_${location}` : String(name),
      width: size,
      height: size,
      correctLevel: QRCode.CorrectLevel.L,
      margin: 2
    });
    // Enable download when canvas is ready
    setTimeout(() => {
      if (qrGenDlBtnEl) qrGenDlBtnEl.disabled = false;
      // Add preview label under the QR
      const label = document.createElement("div");
      label.className = "qrgen__label";
      label.textContent = location ? `${name}_${location}` : String(name);
      qrGenPreviewEl.appendChild(label);
    }, 100);
    lastSingleGenerateAt = now;
    if (qrGenBtnEl) {
      qrGenBtnEl.disabled = true;
      setTimeout(() => { if (qrGenBtnEl) qrGenBtnEl.disabled = false; }, GENERATE_COOLDOWN_MS);
    }
  } catch (err) {
    console.error("QR generation failed", err);
    showToast("QR generation failed", "error");
  }
}

function downloadQrPng() {
  if (!qrGenPreviewEl) return;
  const canvas = qrGenPreviewEl.querySelector("canvas");
  if (!canvas) {
    showToast("Generate a QR first", "error");
    return;
  }
  const name = sanitizeFileName(qrGenNameEl && qrGenNameEl.value);
  const location = sanitizeFileName(qrGenLocationEl && qrGenLocationEl.value);
  const base = [name, location].filter(Boolean).join("_") || "QR";
  const filename = `${base}.png`;
  const link = document.createElement("a");
  link.download = filename;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

if (qrGenBtnEl) qrGenBtnEl.addEventListener("click", generateQr);
if (qrGenDlBtnEl) qrGenDlBtnEl.addEventListener("click", downloadQrPng);

// ===== BULK QR GENERATOR =====
function parseBulkText(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const results = [];
  const header = lines[0].toLowerCase();
  const hasHeader = /name/.test(header) && /location/.test(header);
  const rows = hasHeader ? lines.slice(1) : lines;
  for (const line of rows) {
    const delimiter = line.includes("\t") ? "\t" : ",";
    const parts = line.split(delimiter).map(s => s.trim());
    const name = parts[0] || "";
    const location = parts[1] || "";
    if (!name) continue;
    results.push({ name, location });
  }
  return results;
}

async function generateQrDataUrl(text, size) {
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-9999px";
  document.body.appendChild(container);
  try {
    // eslint-disable-next-line no-undef
    const qr = new QRCode(container, {
      text: String(text),
      width: size,
      height: size,
      correctLevel: QRCode.CorrectLevel.L,
      margin: 2
    });
    // Wait up to ~500ms for canvas/img to appear
    for (let attempt = 0; attempt < 12; attempt++) {
      const canvas = container.querySelector("canvas");
      if (canvas) return canvas.toDataURL("image/png");
      const img = container.querySelector("img");
      if (img && img.src) return img.src;
      await new Promise(r => setTimeout(r, 40));
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    container.remove();
  }
}

async function generateZipFromPairs(pairs) {
  if (!pairs || !pairs.length) {
    showToast("No valid rows found", "error");
    return;
  }
  if (!window.JSZip || !window.saveAs) {
    showToast("ZIP libraries failed to load", "error");
    return;
  }
  const zip = new window.JSZip();
  const size = 512;
  let added = 0;
  for (const { name, location } of pairs) {
    const content = location ? `${String(name).trim()}_${String(location).trim()}` : String(name).trim();
    if (!content) continue;
    const dataUrl = await generateQrDataUrl(content, size);
    if (!dataUrl) continue;
    const base64 = dataUrl.split(",")[1];
    const fileBase = [sanitizeFileName(name), sanitizeFileName(location)].filter(Boolean).join("_") || "QR";
    zip.file(`${fileBase}.png`, base64, { base64: true });
    added++;
  }
  if (!added) {
    showToast("Nothing to add to ZIP", "error");
    return;
  }
  const blob = await zip.generateAsync({ type: "blob" });
  // eslint-disable-next-line no-undef
  window.saveAs(blob, `qr-codes-${Date.now()}.zip`);
  showToast(`✅ Generated ${added} QR(s)`, "success");
}

async function handleBulkGenerate() {
  const now = Date.now();
  if (now - lastBulkGenerateAt < GENERATE_COOLDOWN_MS) {
    const waitMs = GENERATE_COOLDOWN_MS - (now - lastBulkGenerateAt);
    showToast(`Please wait ${Math.ceil(waitMs / 1000)}s before generating again`, "error");
    return;
  }
  if (bulkGenBtnEl) bulkGenBtnEl.disabled = true;
  try {
    // Prefer file content if provided; else use textarea
    let text = bulkTextEl && bulkTextEl.value ? String(bulkTextEl.value) : "";
    const file = bulkFileEl && bulkFileEl.files && bulkFileEl.files[0] ? bulkFileEl.files[0] : null;
    if (file) {
      try {
        text = await file.text();
      } catch (e) {
        showToast("Failed to read file", "error");
      }
    }
    if (!text.trim()) {
      showToast("Provide a CSV/TSV or paste rows", "error");
      return;
    }
    const pairs = parseBulkText(text);
    await generateZipFromPairs(pairs);
    lastBulkGenerateAt = now;
  } finally {
    if (bulkGenBtnEl) {
      const elapsed = Date.now() - now;
      const remaining = Math.max(0, GENERATE_COOLDOWN_MS - elapsed);
      setTimeout(() => { if (bulkGenBtnEl) bulkGenBtnEl.disabled = false; }, remaining);
    }
  }
}

if (bulkGenBtnEl) bulkGenBtnEl.addEventListener("click", handleBulkGenerate);
if (bulkFileEl && bulkTextEl) {
  bulkFileEl.addEventListener("change", async () => {
    const file = bulkFileEl.files && bulkFileEl.files[0] ? bulkFileEl.files[0] : null;
    if (!file) return;
    try {
      const text = await file.text();
      if (text && !bulkTextEl.value) bulkTextEl.value = text;
    } catch {
      // ignore
    }
  });
}

// ===== Wake Lock (keep screen on while scanning) =====
async function acquireWakeLock() {
  try {
    if (document.visibilityState !== "visible") return;
    if ("wakeLock" in navigator && navigator.wakeLock.request) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { /* released */ });
    }
  } catch (_) {
    // ignore
  }
}

async function releaseWakeLock() {
  try {
    if (wakeLock) { await wakeLock.release(); }
  } catch (_) {
    // ignore
  } finally {
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isScanning) {
    acquireWakeLock();
  } else {
    releaseWakeLock();
  }
});

// ===== Site persistence =====
if (siteInputEl) {
  const saved = localStorage.getItem(SITE_KEY);
  if (saved) siteInputEl.value = saved;
  siteInputEl.addEventListener("input", () => {
    localStorage.setItem(SITE_KEY, String(siteInputEl.value || ""));
  });
}

// ===== Analytics =====
async function fetchStatsJSONP(url) {
  return new Promise((resolve, reject) => {
    const cbName = `jsonp_cb_${Date.now()}_${Math.floor(Math.random()*1e6)}`;
    let timeoutId = null;
    window[cbName] = (data) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve(data);
      setTimeout(() => { try { delete window[cbName]; } catch(_){} }, 0);
      script.remove();
    };
    const sep = url.includes("?") ? "&" : "?";
    const script = document.createElement("script");
    script.src = `${url}${sep}action=stats&callback=${cbName}`;
    script.onerror = () => { reject(new Error("Stats load failed")); script.remove(); delete window[cbName]; };
    document.body.appendChild(script);
    // Fail fast if callback never fires (e.g., endpoint doesn't support JSONP)
    timeoutId = setTimeout(() => {
      try { delete window[cbName]; } catch(_){}
      try { script.remove(); } catch(_){}
      reject(new Error("Stats request timed out"));
    }, 6000);
  });
}

function renderStats(data) {
  try {
    const insEl = document.getElementById("kpi-ins");
    const outsEl = document.getElementById("kpi-outs");
    const totalEl = document.getElementById("kpi-total");
    if (insEl) insEl.textContent = String(data?.today?.checkIns || 0);
    if (outsEl) outsEl.textContent = String(data?.today?.checkOuts || 0);
    if (totalEl) totalEl.textContent = String(data?.today?.total || 0);

    const locTodayEl = document.getElementById("table-loc-today");
    const loc7dEl = document.getElementById("table-loc-7d");
    const recentEl = document.getElementById("recent-list");
    if (locTodayEl) {
      locTodayEl.innerHTML = "";
      const entries = Object.entries(data?.byLocationToday || {}).sort((a,b) => b[1]-a[1]);
      if (!entries.length) locTodayEl.textContent = "No data";
      entries.forEach(([loc, count]) => {
        const row = document.createElement("div");
        row.className = "table__row";
        row.innerHTML = `<div>${loc || "(blank)"}</div><div>${count}</div>`;
        locTodayEl.appendChild(row);
      });
    }
    if (loc7dEl) {
      loc7dEl.innerHTML = "";
      const entries7 = Object.entries(data?.byLocation7d || {}).sort((a,b) => b[1]-a[1]);
      if (!entries7.length) loc7dEl.textContent = "No data";
      entries7.forEach(([loc, count]) => {
        const row = document.createElement("div");
        row.className = "table__row";
        row.innerHTML = `<div>${loc || "(blank)"}</div><div>${count}</div>`;
        loc7dEl.appendChild(row);
      });
    }
    if (recentEl) {
      recentEl.innerHTML = "";
      const items = Array.isArray(data?.recent) ? data.recent : [];
      if (!items.length) recentEl.textContent = "No recent scans";
      items.forEach((it) => {
        const div = document.createElement("div");
        div.className = "recent__item";
        const who = it.workerName || it.workerId || "";
        div.innerHTML = `<div>${who} — ${it.action}</div><div class="recent__meta">${it.date} ${it.time} ${it.location ? "• "+it.location : ""}${it.site ? " • "+it.site : ""}</div>`;
        recentEl.appendChild(div);
      });
    }
  } catch (e) {
    // ignore rendering errors
  }
}

async function fetchAndRenderStats() {
  try {
    const url = CONFIG.sheetsEndpoint;
    if (!url) return;
    const data = await fetchStatsJSONP(url);
    if (data && data.status === "ok") {
      renderStats(data);
    } else {
      showToast("Failed to load stats", "error");
    }
  } catch (e) {
    showToast("Failed to load stats", "error");
  }
}

const btnRefreshStats = document.getElementById("btn-refresh-stats");
if (btnRefreshStats) btnRefreshStats.addEventListener("click", fetchAndRenderStats);
function activateTab(which) {
  const panels = [
    { btn: tabScanBtn, panel: sectionScan, key: "scan" },
    { btn: tabGenBtn, panel: sectionGen, key: "generate" },
    { btn: tabAnalyticsBtn, panel: sectionAnalytics, key: "analytics" }
  ];
  panels.forEach(({ btn, panel, key }) => {
    const active = which === key;
    if (btn) {
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    }
    if (panel) panel.classList.toggle("is-active", active);
  });
  if (which === "analytics") {
    fetchAndRenderStats();
  }
}

if (tabScanBtn) tabScanBtn.addEventListener("click", () => activateTab("scan"));
if (tabGenBtn) tabGenBtn.addEventListener("click", () => activateTab("generate"));
if (tabAnalyticsBtn) tabAnalyticsBtn.addEventListener("click", () => activateTab("analytics"));
