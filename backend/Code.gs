/**
 * Google Apps Script Web App to log attendance to Google Sheets.
 *
 * Setup:
 * 1) Create a Google Sheet with headers: WorkerID | Date | Time | Action
 * 2) In Apps Script, add this file, set the sheet name below, deploy as Web App:
 *    - Deployment type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone with the link (or your org)
 * 3) Copy the web app URL and set it in src/config.js as CONFIG.sheetsEndpoint
 */

// Set your Google Sheet ID (from the sheet URL). If empty, the script
// will try to use the active spreadsheet only when bound to a Sheet.
var SHEET_ID = ""; // e.g. 1AbCdefGhIJkLmNoPqRsTuVwXyZ1234567890abcd
var SHEET_NAME = "Attendance";
var REQUIRED_HEADERS = ["WorkerID", "WorkerName", "Location", "Date", "Time", "Action", "Site"]; // order matters

function getOrCreateSheet_() {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("Spreadsheet not found. Set SHEET_ID or bind script to a Sheet.");
  }
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  ensureHeaders_(sheet);
  return sheet;
}

function ensureHeaders_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.appendRow(REQUIRED_HEADERS);
    return;
  }
  var range = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), REQUIRED_HEADERS.length));
  var existing = range.getValues()[0];
  // Build a set of existing headers
  var existingSet = {};
  for (var i = 0; i < existing.length; i++) {
    var name = String(existing[i] || "").trim();
    if (name) existingSet[name] = true;
  }
  // If any required header is missing, rewrite header row to include all required headers (preserving known ones in order)
  var needRewrite = false;
  for (var j = 0; j < REQUIRED_HEADERS.length; j++) {
    if (!existingSet[REQUIRED_HEADERS[j]]) { needRewrite = true; break; }
  }
  if (needRewrite) {
    sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
  }
}

function getHeaderIndexMap_(sheet) {
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  for (var i = 0; i < header.length; i++) {
    var key = String(header[i] || "").trim();
    if (key) map[key] = i;
  }
  return map;
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ status: "error", message: "No body" });
    }

    var data = JSON.parse(e.postData.contents || "{}");
    var workerId = String(data.workerId || "").trim();
    var date = String(data.date || "").trim();
    var time = String(data.time || "").trim();
    var action = String(data.action || "").trim();
    var site = String(data.site || "").trim();

    if (!workerId || !date || !time || !action) {
      return jsonResponse({ status: "error", message: "Missing fields" });
    }

    var sheet = getOrCreateSheet_();
    var idx = getHeaderIndexMap_(sheet);

    // Split workerId into name and location if formatted as Name_Location
    var parts = workerId.split("_");
    var workerName = parts[0] ? String(parts[0]).trim() : "";
    var location = parts.length > 1 ? String(parts.slice(1).join("_")).trim() : "";

    // Build row matching REQUIRED_HEADERS
    var row = [];
    for (var k = 0; k < REQUIRED_HEADERS.length; k++) {
      var col = REQUIRED_HEADERS[k];
      if (col === "WorkerID") row.push(workerId);
      else if (col === "WorkerName") row.push(workerName);
      else if (col === "Location") row.push(location);
      else if (col === "Date") row.push(date);
      else if (col === "Time") row.push(time);
      else if (col === "Action") row.push(action);
      else if (col === "Site") row.push(site);
      else row.push("");
    }
    sheet.appendRow(row);

    return jsonResponse({ status: "ok" });
  } catch (err) {
    return jsonResponse({ status: "error", message: String(err) });
  }
}

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var action = String(params.action || "").trim();
  if (action === "stats") {
    var stats = buildStats_();
    return jsonResponse(stats, params.callback);
  }
  return jsonResponse({ status: "ok" });
}

function jsonResponse(obj, callback) {
  if (callback) {
    var wrapped = callback + "(" + JSON.stringify(obj) + ")";
    var outp = ContentService.createTextOutput(wrapped);
    outp.setMimeType(ContentService.MimeType.JAVASCRIPT);
    return outp;
  }
  var output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function buildStats_() {
  var sheet = getOrCreateSheet_();
  var values = sheet.getDataRange().getValues();
  if (!values || values.length <= 1) {
    return { status: "ok", today: { checkIns: 0, checkOuts: 0, total: 0 }, byLocationToday: {}, byLocation7d: {}, recent: [] };
  }
  var header = values[0];
  var idx = {};
  for (var i = 0; i < header.length; i++) idx[header[i]] = i;
  function col(name) { return idx[name] != null ? idx[name] : -1; }

  var iWorkerId = col("WorkerID");
  var iWorkerName = col("WorkerName");
  var iLocation = col("Location");
  var iDate = col("Date");
  var iTime = col("Time");
  var iAction = col("Action");
  var iSite = col("Site");

  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var msNow = new Date().getTime();
  var ms7d = msNow - 7 * 24 * 60 * 60 * 1000;

  var today = { checkIns: 0, checkOuts: 0, total: 0 };
  var byLocationToday = {};
  var byLocation7d = {};
  var recent = [];

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var d = String(row[iDate] || "");
    var t = String(row[iTime] || "00:00:00");
    var dtStr = d + "T" + t;
    var ms = Date.parse(dtStr);
    var action = String(row[iAction] || "");
    var loc = String(row[iLocation] || "");

    // Today counters
    if (d === todayStr) {
      today.total++;
      if (/check\s*in/i.test(action)) today.checkIns++;
      else if (/check\s*out/i.test(action)) today.checkOuts++;
      byLocationToday[loc] = (byLocationToday[loc] || 0) + 1;
    }

    // Last 7 days by location
    if (!isNaN(ms) && ms >= ms7d) {
      byLocation7d[loc] = (byLocation7d[loc] || 0) + 1;
    }

    // Collect recent (limit 20, from last rows later)
  }

  // Recent: take from bottom up
  var limit = 20;
  for (var r2 = values.length - 1; r2 >= 1 && recent.length < limit; r2--) {
    var row2 = values[r2];
    recent.push({
      workerId: row2[iWorkerId] || "",
      workerName: row2[iWorkerName] || "",
      location: row2[iLocation] || "",
      date: row2[iDate] || "",
      time: row2[iTime] || "",
      action: row2[iAction] || "",
      site: iSite >= 0 ? (row2[iSite] || "") : ""
    });
  }

  return {
    status: "ok",
    today: today,
    byLocationToday: byLocationToday,
    byLocation7d: byLocation7d,
    recent: recent
  };
}
