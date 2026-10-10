# Sky Sail Ops (daily report + offline enquiries)

Standalone Node/Express app, separate from the WhatsApp bot. Two logins per location, one admin. Everything is saved to Google Sheets.

## What it saves (tabs are created automatically)
- `DailyReports`: one row per submitted daily report (date, location, inflow, outflow, net, time, who)
- `DailyReportLines`: one row per inflow/expense item
- `OfflineEnquiries`: walk-in / phone enquiries (name, phone, people, interested in, source, status, follow-up date, notes)

A submit for a date + location that already has a report asks for confirmation before adding another.

## Deploy on Render
1. New GitHub repo with these files, then Render > New > Web Service (or Blueprint using `render.yaml`).
2. Build `npm install`, start `npm start`.
3. Environment variables:
   - `SHEET_ID`: the spreadsheet to write to (same sheet as the bot or a new one)
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the service-account JSON key, as one value (the same key the bot uses works)
   - `ALLEPPEY_PASSWORD`, `BANGALORE_PASSWORD`, `ADMIN_PASSWORD`
4. Share the spreadsheet (Editor) with the service account's `client_email` if it isn't already.

## Logins (browser prompt)
- username `alleppey` + ALLEPPEY_PASSWORD: locked to Alleppey
- username `bangalore` + BANGALORE_PASSWORD: locked to Bangalore
- username `admin` + ADMIN_PASSWORD: can pick either location

## Customise
Preset buttons and the "Interested in" options are at the top of the script in `public/index.html`. Locations, statuses and sources are at the top of `server.js`.
