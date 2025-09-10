import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const CSV_PATH = path.join(__dirname, "attendance-data.csv");

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

function escapeCsv(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function ensureCsvHeader() {
  try {
    if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) {
      fs.writeFileSync(CSV_PATH, "WorkerID,Date,Time,Action\n", { encoding: "utf8" });
    }
  } catch {}
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    return sendNoContent(res);
  }

  if (req.url === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.url === "/log" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
      }
    });
    req.on("end", () => {
      let data;
      try {
        data = JSON.parse(raw || "{}");
      } catch (e) {
        return sendJson(res, 400, { status: "error", message: "Invalid JSON" });
      }

      const workerId = String(data.workerId || "").trim();
      const date = String(data.date || "").trim();
      const time = String(data.time || "").trim();
      const action = String(data.action || "").trim();

      if (!workerId || !date || !time || !action) {
        return sendJson(res, 400, { status: "error", message: "Missing fields" });
      }

      ensureCsvHeader();
      const row = [workerId, date, time, action].map(escapeCsv).join(",") + "\n";
      fs.appendFile(CSV_PATH, row, (err) => {
        if (err) {
          console.error("Failed to append CSV:", err);
          return sendJson(res, 500, { status: "error", message: "Write failed" });
        }
        console.log(`Logged: ${row.trim()}`);
        return sendJson(res, 200, { status: "ok" });
      });
    });
    return;
  }

  sendJson(res, 404, { status: "error", message: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`Attendance local API running on http://localhost:${PORT}`);
  console.log(`CSV file: ${CSV_PATH}`);
});


