import { CONFIG } from "./config.js";

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
const qrGenIdEl = document.getElementById("qrgen-id");
const qrGenBtnEl = document.getElementById("qrgen-generate");
const qrGenDlBtnEl = document.getElementById("qrgen-download");
const qrGenPreviewEl = document.getElementById("qrgen-preview");
// Tabs
const tabScanBtn = document.getElementById("tab-scan");
const tabGenBtn = document.getElementById("tab-generate");
const sectionScan = document.getElementById("section-scan");
const sectionGen = document.getElementById("section-generate");

let html5QrCode = null;
let isScanning = false;
let currentAction = null; // "Check In" | "Check Out"
let availableCameras = [];
let currentCameraId = null;

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
  const config = { fps: 10, qrbox: { width: 280, height: 280 }, aspectRatio: 1.0, rememberLastUsedCamera: true };
  html5QrCode = new Html5Qrcode(qrRegionId);
  isScanning = true;

  const cameraConfig = cameraId ? cameraId : { facingMode: "environment" };

  html5QrCode.start(
    cameraConfig,
    config,
    async (decodedText) => {
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

      try {
        await sendToSheets(payload);
        showToast(`✅ ${currentAction === "Check In" ? "Checked In" : "Checked Out"}`, "success");
      } catch (err) {
        console.error(err);
        showToast("❌ Scan failed, please try again.", "error");
      } finally {
        closeScanner();
      }
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
  const payload = { workerId, date, time, action };
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
  const name = (qrGenNameEl && qrGenNameEl.value) ? qrGenNameEl.value : "";
  const id = (qrGenIdEl && qrGenIdEl.value) ? qrGenIdEl.value : "";
  if (!id) {
    showToast("Please enter Worker ID", "error");
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
      text: String(id),
      width: size,
      height: size,
      correctLevel: QRCode.CorrectLevel.M,
      margin: 2
    });
    // Enable download when canvas is ready
    setTimeout(() => {
      if (qrGenDlBtnEl) qrGenDlBtnEl.disabled = false;
    }, 100);
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
  const id = sanitizeFileName(qrGenIdEl && qrGenIdEl.value);
  const filename = name ? `${name}_${id || "QR"}.png` : `${id || "QR"}.png`;
  const link = document.createElement("a");
  link.download = filename;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

if (qrGenBtnEl) qrGenBtnEl.addEventListener("click", generateQr);
if (qrGenDlBtnEl) qrGenDlBtnEl.addEventListener("click", downloadQrPng);

function activateTab(which) {
  const isScan = which === "scan";
  if (tabScanBtn && tabGenBtn) {
    tabScanBtn.classList.toggle("is-active", isScan);
    tabScanBtn.setAttribute("aria-selected", String(isScan));
    tabGenBtn.classList.toggle("is-active", !isScan);
    tabGenBtn.setAttribute("aria-selected", String(!isScan));
  }
  if (sectionScan && sectionGen) {
    sectionScan.classList.toggle("is-active", isScan);
    sectionGen.classList.toggle("is-active", !isScan);
  }
}

if (tabScanBtn) tabScanBtn.addEventListener("click", () => activateTab("scan"));
if (tabGenBtn) tabGenBtn.addEventListener("click", () => activateTab("generate"));
