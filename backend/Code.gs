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

function getOrCreateSheet_() {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("Spreadsheet not found. Set SHEET_ID or bind script to a Sheet.");
  }
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["WorkerID", "Date", "Time", "Action"]);
  }
  return sheet;
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

    if (!workerId || !date || !time || !action) {
      return jsonResponse({ status: "error", message: "Missing fields" });
    }

    var sheet = getOrCreateSheet_();
    sheet.appendRow([workerId, date, time, action]);

    return jsonResponse({ status: "ok" });
  } catch (err) {
    return jsonResponse({ status: "error", message: String(err) });
  }
}

function doGet() {
  return jsonResponse({ status: "ok" });
}

function jsonResponse(obj) {
  var output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
