import { CONFIG } from "./config.js";

const btnCheckIn = document.getElementById("btn-checkin");
const btnCheckOut = document.getElementById("btn-checkout");
const modalEl = document.getElementById("scanner-modal");
const modalBackdropEl = document.getElementById("scanner-backdrop");
const modalCloseEl = document.getElementById("scanner-close");
const modalCancelEl = document.getElementById("scanner-cancel");
const modalTitleEl = document.getElementById("scanner-title");
const toastContainer = document.getElementById("toast-container");

let html5QrCode = null;
let isScanning = false;
let currentAction = null; // "Check In" | "Check Out"

function openScanner(actionLabel) {
  if (isScanning) return;
  currentAction = actionLabel;
  modalTitleEl.textContent = `Scan QR — ${actionLabel}`;
  modalEl.setAttribute("aria-hidden", "false");
  startScanner();
}

function closeScanner() {
  stopScanner();
  modalEl.setAttribute("aria-hidden", "true");
}

function startScanner() {
  const qrRegionId = "qr-reader";
  const config = { fps: 10, qrbox: { width: 280, height: 280 }, aspectRatio: 1.0, rememberLastUsedCamera: true };
  html5QrCode = new Html5Qrcode(qrRegionId);
  isScanning = true;

  html5QrCode.start(
    { facingMode: "environment" },
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
    showToast("❌ Scan failed, please try again.", "error");
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
