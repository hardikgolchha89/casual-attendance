# Attendance Scanner

Lightweight web app to scan worker QR codes and log Check In/Check Out into Google Sheets.

## Features
- Two-button home: Check In, Check Out
- Camera-based QR scanning (using `html5-qrcode`)
- Sends WorkerID, Date, Time, Action to Google Sheets endpoint
- Toast notifications for success / failure

## Frontend Setup
1. Open `src/config.js` and set `CONFIG.sheetsEndpoint` to your Google Apps Script Web App URL.
2. Serve the folder with any static server (to use camera permissions over `http://localhost` or `https`):
   - Python: `python3 -m http.server 5173`
   - Node: `npx serve` or `npx http-server`
3. Visit `http://localhost:5173` (or the port from your server) and allow camera.

## Google Sheets Backend (Google Apps Script)
1. Create a new Google Sheet. Add a sheet named `Attendance` with headers in row 1:
   - `WorkerID`, `Date`, `Time`, `Action` (or let the script create them automatically)
2. Open `Extensions > Apps Script` and add the file content from `backend/Code.gs`.
3. Click `Deploy > New deployment > Web app`:
   - Description: Attendance API
   - Execute as: Me
   - Who has access: Anyone with the link (or your org)
4. Copy the Web App URL and set it in `src/config.js` as `CONFIG.sheetsEndpoint`.

### CORS
The script returns JSON. If blocked by CORS, you may need to publish under your domain or use a reverse proxy. Typically Apps Script Web Apps accept CORS for simple POSTs.

## Data Format
The frontend sends a POST JSON body:
```json
{
  "workerId": "QR_TEXT",
  "date": "YYYY-MM-DD",
  "time": "HH:mm:ss",
  "action": "Check In" | "Check Out"
}
```
The Apps Script appends a row to the `Attendance` sheet.

## Notes
- The QR content should be the unique WorkerID.
- If the scanning or logging fails, a red toast appears and the scanner closes.
- Camera works only under secure context (localhost or https).


## Local Development API
You can run a local API to avoid Apps Script while developing.

Start the API (port 8787):
```bash
node backend/server.mjs
```
It will create/append to `backend/attendance-data.csv` with rows: `WorkerID,Date,Time,Action`.

When you open the app on `http://localhost:*`, it will automatically POST to `http://localhost:8787/log`.

Static server for the frontend (example):
```bash
cd ~/attendance-scanner
python3 -m http.server 5173
```
Then visit `http://localhost:5173`.
