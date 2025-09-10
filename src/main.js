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

let html5QrCode = null;
let isScanning = false;
let currentAction = null; // "Check In" | "Check Out"
let availableCameras = [];
let currentCameraId = null;

const LAST_CAMERA_KEY = "attendance:lastCameraId";
const HTML5_QRCODE_CDNS = [
  "https://unpkg.com/html5-qrcode@2.3.10/html5-qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.10/html5-qrcode.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.10/html5-qrcode.min.js"
];

function ensureHtml5QrcodeLoaded() {
  return new Promise((resolve, reject) => {
    try {
      if (typeof window !== "undefined" && window.Html5Qrcode) {
        return resolve();
      }

      const loadFrom = (index) => {
        if (typeof window !== "undefined" && window.Html5Qrcode) {
          return resolve();
        }
        if (index >= HTML5_QRCODE_CDNS.length) {
          return reject(new Error("Failed to load html5-qrcode from all CDNs"));
        }

        // Reuse existing loader if already present for this URL
        const currentSrc = HTML5_QRCODE_CDNS[index];
        let existing = document.querySelector(`script[data-html5-qrcode][src='${currentSrc}']`);
        if (!existing) {
          existing = document.createElement("script");
          existing.src = currentSrc;
          existing.async = true;
          existing.setAttribute("data-html5-qrcode", "");
          document.head.appendChild(existing);
        }
        existing.onload = () => resolve();
        existing.onerror = () => loadFrom(index + 1);
      };

      loadFrom(0);
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
    showToast("❌ Camera library failed to load. Check connection or content blockers.", "error");
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
    // Choose last used or the first one
    const selectedId = availableCameras.find(c => c.id === lastId) ? lastId : availableCameras[0].id;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs || 12000);

  const res = await fetch(CONFIG.sheetsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workerId, date, time, action }),
    signal: controller.signal,
    mode: "cors",
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Bad response: ${res.status} ${txt}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!data || data.status !== "ok") {
    throw new Error("Sheets API error");
  }
  return data;
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
